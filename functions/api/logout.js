// POST /api/logout -> deletes session, clears cookie
import { json, sessionToken } from '../_auth.js';

export async function onRequestPost({ request, env }) {
  const token = sessionToken(request);
  if (token) await env.NAV_KV.delete('sess:' + token);
  return json({ ok: true }, 200, {
    'Set-Cookie': 'ymnav=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
  });
}
