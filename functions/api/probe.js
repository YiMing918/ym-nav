// POST /api/probe — liveness check for bookmark URLs (admin only).
// Body: { items: [{ id, url }] } (max 25 per call, client batches).
// Returns { results: [{ id, status, code }] } with status:
//   alive   — reachable (2xx/3xx, or 401/403 = site is up, just restricted)
//   dead    — 404 / 410 (very likely gone)
//   unknown — timeout, network error, 5xx, blocked host (NOT proof of death)
//
// SSRF hardening: probing goes through safeFetch() (functions/_ssrf.js)
// — redirects are followed manually, at most 5 hops, and every hop
// target is re-validated; a hop into loopback / private / reserved
// space aborts the probe and reports 'unknown' (never 'dead': a
// blocked hop says nothing about whether the site itself is gone).
// Rate limiting: this endpoint previously had no KV limiter (only the
// login requirement and the 25-item batch cap), so the same isomorphic
// gate as login/icon is applied per IP: "rl:probe:<ip>", 15-min
// window, 15-min lock, 30 calls per window (30 x 25 = 750 URLs — far
// above any hand-run liveness sweep, far below an abuse loop).
import { json, isAuthed } from '../_auth.js';
import { assertSafeUrl, safeFetch, rateLimited } from '../_ssrf.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function probeOne(item) {
  let u;
  try { u = assertSafeUrl(item.url); } catch {
    // Original mapping preserved: unparseable -> 'dead', parseable
    // but unsafe (protocol / blocked host) -> 'unknown'.
    let parseable = true;
    try { new URL(item.url); } catch { parseable = false; }
    return { id: item.id, status: parseable ? 'unknown' : 'dead', code: 0 };
  }
  try {
    const r = await safeFetch(u.toString(), {
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*' },
    }, { timeoutMs: 6000 });
    try { if (r.body) await r.body.cancel(); } catch { /* ignore */ }
    const s = r.status;
    if (s >= 200 && s < 400) return { id: item.id, status: 'alive', code: s };
    if (s === 401 || s === 403) return { id: item.id, status: 'alive', code: s };
    if (s === 404 || s === 410) return { id: item.id, status: 'dead', code: s };
    return { id: item.id, status: 'unknown', code: s };
  } catch (e) {
    // SsrfError (a redirect hop was blocked / too many redirects) and
    // network/timeout errors alike: 'unknown', never 'dead'. For an
    // over-redirect chain keep the last redirect status as the code.
    const code = e && e.name === 'SsrfError' && e.status ? e.status : 0;
    return { id: item.id, status: 'unknown', code };
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.NAV_KV) return json({ error: 'KV binding NAV_KV missing' }, 500);
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, 401);
  if (await rateLimited(env, request, { scope: 'probe', limit: 30 })) {
    return json({ error: 'too many attempts, try again in 15 minutes' }, 429);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'bad json' }, 400);
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
