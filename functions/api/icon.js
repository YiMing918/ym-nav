// GET /api/icon?u=<site url> — resolve and cache a site's own icon.
// Parses the site's homepage for <link rel="icon"> / apple-touch-icon (largest
// first), falls back to /apple-touch-icon.png and /favicon.ico. Successful
// icons are cached in KV by host (key "icon:<host>"); misses are cached for
// 7 days so dead sites are not refetched on every page view.
import { json } from '../_auth.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function blockedHost(host) {
  const h = (host || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const p = h.split('.').map(Number);
    const a = p[0], b = p[1];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

function imgResp(buf, type) {
  return new Response(buf, {
    status: 200,
    headers: { 'Content-Type': type || 'image/x-icon', 'Cache-Control': 'public, max-age=604800' },
  });
}

async function fetchIconBytes(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(5000) });
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
    const r = await fetch(u.toString(), { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(6000) });
    if (r.ok) {
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
        try { candidates.push(new URL(l.href, u).toString()); } catch { /* skip */ }
      }
    }
  } catch { /* fall through to defaults */ }
  candidates.push(u.origin + '/apple-touch-icon.png', u.origin + '/favicon.ico');
  for (const c of [...new Set(candidates)]) {
    try {
      const got = await fetchIconBytes(c);
      if (got) return got;
    } catch { /* try next */ }
  }
  return null;
}

export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams.get('u');
  if (!q) return json({ error: 'missing u' }, 400);
  let u;
  try { u = new URL(q); } catch { return json({ error: 'bad url' }, 400); }
  if (!/^https?:$/.test(u.protocol) || blockedHost(u.hostname)) return json({ error: 'blocked' }, 400);
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
