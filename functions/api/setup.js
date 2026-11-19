// POST /api/setup
//  - First run (no admin stored): { password } creates the admin password and logs in.
//    SETUP_KEY compared in constant time (H2); failed attempts rate-limited like login.
//  - Change password (logged in):  { oldPassword, newPassword }
import { json, getAdmin, getAdminState, kvMissing, sameOriginOk, timingSafeEq, hashPassword, verifyPassword, randomHex, createSession, sessionCookie, isAuthed, adminVer } from '../_auth.js';
const setupFails = new Map();
function rlLocked(ip) { const r = setupFails.get(ip); return !!(r && r.lockUntil && r.lockUntil > Date.now()); }
function rlRecordFail(ip) {
  const now = Date.now(); let r = setupFails.get(ip);
  if (!r || !r.winStart || now - r.winStart > 15 * 60 * 1000) r = { fails: 0, winStart: now, lockUntil: 0 };
  r.fails = (r.fails || 0) + 1; if (r.fails >= 5) r.lockUntil = now + 15 * 60 * 1000;
  setupFails.set(ip, r);
}
const MAX_PW = 128;
export async function onRequestPost({ request, env }) {
  if (kvMissing(env)) return json({ error: 'KV binding NAV_KV missing' }, 500);
  if (!sameOriginOk(request)) return json({ error: 'cross-origin request rejected' }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'bad json' }, 400);
  const state = await getAdminState(env);
  if (state.corrupt) return json({ error: 'admin record corrupted; restore the admin key in KV before setup' }, 500);
  const admin = state.admin;
  if (!admin) {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    if (rlLocked(ip)) return json({ error: 'too many attempts, try again in 15 minutes' }, 429);
    if (env.SETUP_KEY && !timingSafeEq(String(body.setupKey || ''), String(env.SETUP_KEY))) {
      rlRecordFail(ip);
      return json({ error: 'setup key required' }, 403);
    }
    const password = String(body.password || '');
    const username = String(body.username || '').trim();
    if (!username) return json({ error: 'username required' }, 400);
    if (username.length > 64) return json({ error: 'username too long' }, 400);
    if (password.length < 6) return json({ error: 'password too short (min 6)' }, 400);
    if (password.length > MAX_PW) return json({ error: 'password too long' }, 400);
    const salt = randomHex(16);
    const hash = await hashPassword(password, salt);
    await env.NAV_KV.put('admin', JSON.stringify({ username, salt, hash, ver: 1 }));
    const check = await getAdmin(env);
    if (!check || check.salt !== salt || check.hash !== hash) {
      return json({ error: 'setup conflict, please reload and sign in to confirm' }, 409);
    }
    setupFails.delete(ip);
    const token = await createSession(env);
    return json({ ok: true, created: true }, 200, { 'Set-Cookie': sessionCookie(token) });
  }
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, 401);
  if (!(await verifyPassword(String(body.oldPassword || ''), admin))) return json({ error: 'wrong old password' }, 403);
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 6) return json({ error: 'password too short (min 6)' }, 400);
  if (newPassword.length > MAX_PW) return json({ error: 'password too long' }, 400);
  if (await verifyPassword(newPassword, admin)) return json({ error: 'new password must differ from old password' }, 400);
  const salt = randomHex(16);
  const hash = await hashPassword(newPassword, salt);
  const ver = adminVer(admin) + 1;
  await env.NAV_KV.put('admin', JSON.stringify({ username: admin.username || '', salt, hash, ver }));
  const token = await createSession(env);
  return json({ ok: true, changed: true }, 200, { 'Set-Cookie': sessionCookie(token) });
}
