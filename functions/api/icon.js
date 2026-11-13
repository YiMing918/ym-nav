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
// requests per 15-min window — login's threshold of 5 counts *failures*;
// icons are counted per request and a nav page legitimately needs
// dozens, hence the higher number on the same mechanism. The counter is
// deliberately NOT in KV: a per-request KV write here is what exhausted
// the account's daily KV write quota on 2026-11-12.
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
  if (await rateLimited(env, request, { scope: 'icon', limit: 120 })) {
    return json({ error: 'too many attempts, try again in 15 minutes' }, 429);
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
  const icon = await resolveIcon(u);
  if (!icon) {
    if (env.NAV_KV) { try { await env.NAV_KV.put(key + ':miss', '1', { expirationTtl: 30 * 24 * 3600 }); } catch { /* ignore */ } }
    return json({ error: 'no icon' }, 404);
  }
  if (env.NAV_KV) {
    try {
      await env.NAV_KV.put(key, icon.buf);
      await env.NAV_KV.put(key + ':t', icon.type);
    } catch { /* ignore */ }
  }
  return imgResp(icon.buf, icon.type);
}
