// GET /api/icon?u=<site url> — resolve and cache a site's own icon.
// Parses the site's homepage for <link rel="icon"> / apple-touch-icon (largest
// first), falls back to /apple-touch-icon.png and /favicon.ico. Successful
// icons are cached in KV by host (key "icon:<host>"); misses are cached for
// 30 days so dead sites are not refetched on every page view.
//
// SSRF hardening: every outbound fetch goes through safeFetch()
// (functions/_ssrf.js) — redirects are followed manually, at most 5
// hops, and every hop target is re-validated, so a public page cannot
// bounce this endpoint into loopback / private / reserved addresses.
// Rate limiting: per-IP in-memory counter (functions/_ssrf.js) at 120
// per 15-min window, counted only on cache MISSES (counting hits used
// to burn the budget on a cold first paint and 429 the owner himself).
// The counter is deliberately NOT in KV: a per-request KV write here
// is what exhausted the account's daily KV write quota on 2026-11-12.
// Cache writes are additionally restricted to hosts that exist in the
// site config — a stranger host is resolved live but never persisted,
// so wildcard-DNS host spraying cannot mint KV writes.
import { json } from '../_auth.js';
import { assertSafeUrl, safeFetch, rateLimited, readBodyLimited } from '../_ssrf.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function imgResp(buf, type) {
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': type || 'image/x-icon',
      'Cache-Control': 'public, max-age=604800',
      // Icons are third-party bytes served from this site's own origin.
      // SVG is rejected in fetchIconBytes, and these headers are the
      // second wall: even if something scriptable ever got through, a
      // direct visit to the icon URL runs it in a sandboxed, opaque
      // origin with no access to the admin session.
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function fetchIconBytes(url) {
  const r = await safeFetch(url, { headers: { 'User-Agent': UA } }, { timeoutMs: 5000 });
  if (!r.ok) return null;
  const type = (r.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  // SVG is an XML document that can carry script — never proxy it from
  // this origin, no matter what the remote server claims.
  if (type === 'image/svg+xml') return null;
  let buf;
  try {
    buf = await readBodyLimited(r, { maxBytes: 512 * 1024, timeoutMs: 8000 });
  } catch { return null; }
  if (!buf.byteLength) return null;
  if (type && !type.startsWith('image/') && !type.includes('icon')) return null;
  // Content sniff as a backstop: a mislabelled SVG/HTML body starts with
  // '<' (after any BOM / whitespace); real raster icons never do.
  const bytes = new Uint8Array(buf.slice(0, 64));
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  if (bytes[i] === 0x3c) return null; // '<'
  return { buf, type: type || 'image/x-icon' };
}

async function resolveIcon(u) {
  const candidates = [];
  try {
    const r = await safeFetch(u.toString(), { headers: { 'User-Agent': UA, 'Accept': 'text/html' } }, { timeoutMs: 6000 });
    if (r.ok) {
      // Resolve relative icon hrefs against the final URL after any
      // (validated) redirects, not the originally requested one.
      let base = u;
      try { if (r.url) base = new URL(r.url); } catch { /* keep original base */ }
      // Bounded read: a hostile homepage could otherwise stream an
      // unbounded body into memory (safeFetch's timeout ends at headers).
      const html = new TextDecoder().decode(await readBodyLimited(r, { maxBytes: 1024 * 1024, timeoutMs: 8000 }));
      const links = [];
      const re = /<link[^>]+>/gi;
      let m;
      while ((m = re.exec(html))) {
        const tag = m[0];
        const rel = (tag.match(/rel=["']([^"']+)["']/i) || [])[1] || '';
        if (!/icon/i.test(rel)) continue;
        const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
        if (!href) continue;
        const sizes = (tag.match(/sizes=["'](\d+)x\d+["']/i) || [])[1];
        let score = sizes ? +sizes : 0;
        if (/apple-touch-icon/i.test(rel)) score += 1000;
        links.push({ href, score });
      }
      links.sort((a, b) => b.score - a.score);
      for (const l of links) {
        try { candidates.push(assertSafeUrl(new URL(l.href, base)).toString()); } catch { /* unsafe candidate: skip */ }
      }
    }
  } catch { /* blocked hop / timeout / network error: fall through to defaults */ }
  candidates.push(u.origin + '/apple-touch-icon.png', u.origin + '/favicon.ico');
  for (const c of [...new Set(candidates)]) {
    try {
      const got = await fetchIconBytes(c);
      if (got) return got;
    } catch { /* unsafe or failed candidate (incl. a blocked redirect hop): try next */ }
  }
  return null;
}

// Keep the original error split: unparseable input -> 'bad url',
// parseable but unsafe -> 'blocked'.
function isBadSyntax(q) {
  try { new URL(q); return false; } catch { return true; }
}

export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams.get('u');
  if (!q) return json({ error: 'missing u' }, 400);
  let u;
  try { u = assertSafeUrl(q); } catch {
    return json({ error: isBadSyntax(q) ? 'bad url' : 'blocked' }, 400);
  }
  const host = u.hostname.toLowerCase();
  const key = 'icon:' + host;
  if (env.NAV_KV) {
    try {
      const hit = await env.NAV_KV.get(key, 'arrayBuffer');
      if (hit) return imgResp(hit, (await env.NAV_KV.get(key + ':t')) || undefined);
      if (await env.NAV_KV.get(key + ':miss')) return json({ error: 'no icon' }, 404);
    } catch { /* cache read failed; resolve live */ }
  }
  // 限流只管「真要外抓 + 写 KV」的未命中路径：以前它排在查缓存之前，
  // 命中缓存的请求也烧额度，公开区 200 多个图标首屏集中加载时可能
  // 把站长自己误伤成 429（图标回退成字母，看着像站点坏了）。
  if (await rateLimited(env, request, { scope: 'icon', limit: 120 })) {
    return json({ error: 'too many attempts, try again in 15 minutes' }, 429);
  }
  // 只给「配置里真实存在的链接主机」落缓存：缓存键按主机名，陌生
  // 主机（比如泛解析批量造的子域名）以前也能各写一份图标进来，
  // 持续消耗全账号写额度。陌生主机照常实时解析返回、只是不落 KV。
  let cacheable = false;
  if (env.NAV_KV) {
    try {
      const rawCfg = await env.NAV_KV.get('site_config');
      if (rawCfg) {
        const cfg = JSON.parse(rawCfg);
        const hosts = new Set();
        for (const s of cfg.sections || []) for (const l of s.links || []) {
          try { hosts.add(new URL(l.url).hostname.toLowerCase()); } catch { /* skip bad url */ }
        }
        cacheable = hosts.has(host);
      }
    } catch { /* config unreadable: resolve live without caching */ }
  }
  const icon = await resolveIcon(u);
  if (!icon) {
    if (env.NAV_KV && cacheable) { try { await env.NAV_KV.put(key + ':miss', '1', { expirationTtl: 30 * 24 * 3600 }); } catch { /* ignore */ } }
    return json({ error: 'no icon' }, 404);
  }
  if (env.NAV_KV && cacheable) {
    try {
      // 成功条目也给 90 天 TTL：以前永不过期，站点换了图标这边永远
      // 是旧的，KV 也只增不减
      await env.NAV_KV.put(key, icon.buf, { expirationTtl: 90 * 24 * 3600 });
      await env.NAV_KV.put(key + ':t', icon.type, { expirationTtl: 90 * 24 * 3600 });
    } catch { /* ignore */ }
  }
  return imgResp(icon.buf, icon.type);
}
