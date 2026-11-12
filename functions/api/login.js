// POST /api/login { username, password } -> sets HttpOnly session cookie
import { json, getAdmin, hashPassword, createSession, sessionCookie } from '../_auth.js';

// 登录失败限流：同来源 IP 15 分钟内失败 >=5 次锁定 15 分钟。
// 计数只存内存（按 isolate），不写 KV：旧版每次失败都往 KV 写一次，
// 而图标/探测接口的同款 KV 限流器在 2026-11-12 把全账号 1000 次/天
// 的免费写入额度烧穿、连累主账号所有项目登录全灭。内存计数是尽力
// 而为（每个 isolate 独立计数、回收即清零），对单人站点挡爆破足够。
const loginFails = new Map();
function rlLocked(ip) {
  const r = loginFails.get(ip);
  return !!(r && r.lockUntil && r.lockUntil > Date.now());
}
function rlRecordFail(ip) {
  const now = Date.now();
  let r = loginFails.get(ip);
  if (!r || !r.winStart || now - r.winStart > 15 * 60 * 1000) {
    r = { fails: 0, winStart: now, lockUntil: 0 };
  }
  r.fails = (r.fails || 0) + 1;
  if (r.fails >= 5) r.lockUntil = now + 15 * 60 * 1000;
  loginFails.set(ip, r);
}

export async function onRequestPost({ request, env }) {
  const admin = await getAdmin(env);
  if (!admin) return json({ error: 'not_setup' }, 400);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (rlLocked(ip)) return json({ error: 'too many attempts, try again in 15 minutes' }, 429);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const password = String(body.password || '');
  const username = String(body.username || '').trim();
  if (!password) return json({ error: 'empty password' }, 400);
  const fail = () => {
    rlRecordFail(ip);
    return json({ error: 'wrong credentials' }, 403);
  };
  if (admin.username && username !== admin.username) return fail();
  const hash = await hashPassword(password, admin.salt);
  if (hash !== admin.hash) return fail();
  loginFails.delete(ip);
  const token = await createSession(env);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
}
