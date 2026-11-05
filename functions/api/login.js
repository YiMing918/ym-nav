// POST /api/login { username, password } -> sets HttpOnly session cookie
import { json, getAdmin, hashPassword, createSession, sessionCookie } from '../_auth.js';

export async function onRequestPost({ request, env }) {
  const admin = await getAdmin(env);
  if (!admin) return json({ error: 'not_setup' }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const password = String(body.password || '');
  const username = String(body.username || '').trim();
  if (!password) return json({ error: 'empty password' }, 400);
  if (admin.username && username !== admin.username) return json({ error: 'wrong credentials' }, 403);
  const hash = await hashPassword(password, admin.salt);
  if (hash !== admin.hash) return json({ error: 'wrong credentials' }, 403);
  const token = await createSession(env);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
}
