// POST /api/setup
//  - First run (no admin stored): { password } creates the admin password and logs in.
//    If the deployer set a SETUP_KEY environment variable, first-run setup
//    also requires { setupKey } to match it — otherwise anyone who finds a
//    fresh, uninitialised deployment before its owner could claim it.
//    Deployments without SETUP_KEY behave exactly as before.
//  - Change password (logged in):  { oldPassword, newPassword }
//    Bumps the admin session version, which invalidates every existing
//    session (see _auth.js); the caller gets a fresh session cookie so
//    they stay logged in on this device.
import { json, getAdmin, hashPassword, randomHex, createSession, sessionCookie, isAuthed, adminVer } from '../_auth.js';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const admin = await getAdmin(env);

  if (!admin) {
    if (env.SETUP_KEY && String(body.setupKey || '') !== String(env.SETUP_KEY)) {
      return json({ error: 'setup key required' }, 403);
    }
    const password = String(body.password || '');
    const username = String(body.username || '').trim();
    if (password.length < 6) return json({ error: 'password too short (min 6)' }, 400);
    const salt = randomHex(16);
    const hash = await hashPassword(password, salt);
    await env.NAV_KV.put('admin', JSON.stringify({ username, salt, hash, ver: 1 }));
    const token = await createSession(env);
    return json({ ok: true, created: true }, 200, { 'Set-Cookie': sessionCookie(token) });
  }

  // Change password requires a valid session + the old password.
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, 401);
  const oldHash = await hashPassword(String(body.oldPassword || ''), admin.salt);
  if (oldHash !== admin.hash) return json({ error: 'wrong old password' }, 403);
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 6) return json({ error: 'password too short (min 6)' }, 400);
  const salt = randomHex(16);
  const hash = await hashPassword(newPassword, salt);
  const ver = adminVer(admin) + 1;
  await env.NAV_KV.put('admin', JSON.stringify({ username: admin.username || '', salt, hash, ver }));
  const token = await createSession(env);
  return json({ ok: true, changed: true }, 200, { 'Set-Cookie': sessionCookie(token) });
}
