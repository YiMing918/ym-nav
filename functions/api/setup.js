// POST /api/setup
//  - First run (no admin stored): { password } creates the admin password and logs in.
//  - Change password (logged in):  { oldPassword, newPassword }
import { json, getAdmin, hashPassword, randomHex, createSession, sessionCookie, isAuthed } from '../_auth.js';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const admin = await getAdmin(env);

  if (!admin) {
    const password = String(body.password || '');
    const username = String(body.username || '').trim();
    if (password.length < 4) return json({ error: 'password too short (min 4)' }, 400);
    const salt = randomHex(16);
    const hash = await hashPassword(password, salt);
    await env.NAV_KV.put('admin', JSON.stringify({ username, salt, hash }));
    const token = await createSession(env);
    return json({ ok: true, created: true }, 200, { 'Set-Cookie': sessionCookie(token) });
  }

  // Change password requires a valid session + the old password.
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, 401);
  const oldHash = await hashPassword(String(body.oldPassword || ''), admin.salt);
  if (oldHash !== admin.hash) return json({ error: 'wrong old password' }, 403);
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 4) return json({ error: 'password too short (min 4)' }, 400);
  const salt = randomHex(16);
  const hash = await hashPassword(newPassword, salt);
  await env.NAV_KV.put('admin', JSON.stringify({ username: admin.username || '', salt, hash }));
  return json({ ok: true, changed: true });
}
