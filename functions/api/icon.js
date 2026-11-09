// GET /api/icon?u=<site url> — resolve and cache a site's own icon.
// Parses the site's homepage for <link rel="icon"> / apple-touch-icon (largest
// first), falls back to /apple-touch-icon.png and /favicon.ico. Successful
// icons are cached in KV by host (key "icon:<host>"); misses are cached for
// 7 days so dead sites are not refetched on every page view.
//
// SSRF hardening: every outbound fetch goes through safeFetch()
// (functions/_ssrf.js) — redirects are followed manually, at most 5
// hops, and every hop target is re-validated, so a public page cannot
// bounce this endpoint into loopback / private / reserved addresses.
// Rate limiting: per-IP KV counter isomorphic to the login limiter
// ("rl:icon:<ip>", 15-min window, 15-min lock, 2-day TTL) at 120
// requests per window — login's threshold of 5 counts *failures*;
// icons are counted per request and a nav page legitimately needs
// dozens, hence the higher number on the same mechanism.
import { json } from '../_auth.js';
import { assertSafeUrl, safeFetch, rateLimited } from '../_ssrf.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function imgResp(buf, type) {
  return new Response(buf, {
    status: 200,
    headers: { 'Content-Type': type || 'image/x-icon', 'Cache-Control': 'public, max-age=604800' },
  });
}

async function fetchIconBytes(url) {
  const r = await safeFetch(url, { headers: { 'User-Agent': UA } }, { timeoutMs: 5000 });
  if (!r.ok) return null;
  const type = (r.headers.get('Content-Type') || '').split(';')[0].trim();
  const buf = await r.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > 512 * 1024) return null;
  if (type && !type.startsWith('image/') && !type.includes('icon')) return null;
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
      const html = await r.text();
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
    if (env.NAV_KV) { try { await env.NAV_KV.put(key + ':miss', '1', { expirationTtl: 7 * 24 * 3600 }); } catch { /* ignore */ } }
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
