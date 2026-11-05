// POST /api/probe — liveness check for bookmark URLs (admin only).
// Body: { items: [{ id, url }] } (max 25 per call, client batches).
// Returns { results: [{ id, status, code }] } with status:
//   alive   — reachable (2xx/3xx, or 401/403 = site is up, just restricted)
//   dead    — 404 / 410 (very likely gone)
//   unknown — timeout, network error, 5xx, blocked host (NOT proof of death)
import { json, isAuthed } from '../_auth.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function blockedHost(host) {
  const h = (host || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const parts = h.split('.').map(Number);
    const a = parts[0], b = parts[1];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

async function probeOne(item) {
  let u;
  try { u = new URL(item.url); } catch { return { id: item.id, status: 'dead', code: 0 }; }
  if (!/^https?:$/.test(u.protocol) || blockedHost(u.hostname)) {
    return { id: item.id, status: 'unknown', code: 0 };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(u.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*' },
    });
    clearTimeout(timer);
    try { await r.body.cancel(); } catch { /* ignore */ }
    const s = r.status;
    if (s >= 200 && s < 400) return { id: item.id, status: 'alive', code: s };
    if (s === 401 || s === 403) return { id: item.id, status: 'alive', code: s };
    if (s === 404 || s === 410) return { id: item.id, status: 'dead', code: s };
    return { id: item.id, status: 'unknown', code: s };
  } catch {
    clearTimeout(timer);
    return { id: item.id, status: 'unknown', code: 0 };
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.NAV_KV) return json({ error: 'KV binding NAV_KV missing' }, 500);
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const items = Array.isArray(body.items) ? body.items.slice(0, 25) : [];
  const queue = [...items];
  const results = [];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const it = queue.shift();
      results.push(await probeOne(it));
    }
  });
  await Promise.all(workers);
  return json({ results });
}
