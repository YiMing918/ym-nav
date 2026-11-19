// POST /api/logout -> deletes session, clears cookie
import { json, sessionToken, sessionKey, sameOriginOk } from '../_auth.js';

export async function onRequestPost({ request, env }) {
  if (!sameOriginOk(request)) return json({ error: 'cross-origin request rejected' }, 403);
  if (!env || !env.NAV_KV) return json({ ok: true }, 200, { 'Set-Cookie': 'ymnav=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' });
  const token = sessionToken(request);
  if (token) await env.NAV_KV.delete(await sessionKey(token));
  return json({ ok: true }, 200, {
    'Set-Cookie': 'ymnav=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
  });
}
