// POST /api/login { username, password } -> sets HttpOnly session cookie
import { json, getAdmin, hashPassword, createSession, sessionCookie } from '../_auth.js';

// 登录失败限流：同来源 IP 15 分钟内失败 >=5 次锁定 15 分钟（计数存 NAV_KV）
async function rlState(env, ip) {
  try { return JSON.parse((await env.NAV_KV.get('rl:login:' + ip)) || 'null'); } catch { return null; }
}

export async function onRequestPost({ request, env }) {
  const admin = await getAdmin(env);
  if (!admin) return json({ error: 'not_setup' }, 400);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const st = await rlState(env, ip);
  if (st && st.lockUntil && st.lockUntil > Date.now()) return json({ error: 'too many attempts, try again in 15 minutes' }, 429);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const password = String(body.password || '');
  const username = String(body.username || '').trim();
  if (!password) return json({ error: 'empty password' }, 400);
  const fail = async () => {
    const now = Date.now();
    const r = st && st.winStart && now - st.winStart <= 15 * 60 * 1000 ? st : { fails: 0, winStart: now, lockUntil: 0 };
    r.fails = (r.fails || 0) + 1;
    if (r.fails >= 5) r.lockUntil = now + 15 * 60 * 1000;
    await env.NAV_KV.put('rl:login:' + ip, JSON.stringify(r), { expirationTtl: 2 * 24 * 3600 });
    return json({ error: 'wrong credentials' }, 403);
  };
  if (admin.username && username !== admin.username) return fail();
  const hash = await hashPassword(password, admin.salt);
  if (hash !== admin.hash) return fail();
  await env.NAV_KV.delete('rl:login:' + ip);
  const token = await createSession(env);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
}
