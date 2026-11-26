// POST /api/login { username, password } -> sets HttpOnly session cookie
import { json, getAdmin, kvMissing, sameOriginOk, verifyPassword, hashPassword, isLegacyHash, createSession, sessionCookie } from '../_auth.js';
import { makeFailLimiter } from '../_ssrf.js';

// 登录失败限流：同来源 IP 15 分钟内失败 >=5 次锁定 15 分钟。
// 计数只存内存（按 isolate），不写 KV：旧版每次失败都往 KV 写一次，
// 而图标/探测接口的同款 KV 限流器在 2026-11-12 把全账号 1000 次/天
// 的免费写入额度烧穿、连累主账号所有项目登录全灭。内存计数是尽力
// 而为（每个 isolate 独立计数、回收即清零），对单人站点挡爆破足够。
const { locked: rlLocked, recordFail: rlRecordFail, clear: rlClear } = makeFailLimiter();

export async function onRequestPost({ request, env }) {
  if (kvMissing(env)) return json({ error: 'KV binding NAV_KV missing' }, 500);
  if (!sameOriginOk(request)) return json({ error: 'cross-origin request rejected' }, 403);
  const admin = await getAdmin(env);
  if (!admin) return json({ error: 'not_setup' }, 400);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (rlLocked(ip)) return json({ error: 'too many attempts, try again in 15 minutes' }, 429);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'bad json' }, 400);
  const password = String(body.password || '');
  const username = String(body.username || '').trim();
  if (!password) return json({ error: 'empty password' }, 400);
  const fail = () => {
    rlRecordFail(ip);
    return json({ error: 'wrong credentials' }, 403);
  };
  if (password.length > 128) return fail();
  // 【C-29 修复】用户名与口令分开验：用户名不对时也照样跑一遍口令
  // 哈希再判失败，避免「用户名错 → 立刻返回、用户名对 → 慢」的耗时
  // 差把真实用户名漏出去（旧版第一行命中就短路、不跑哈希）。
  const userOk = !admin.username || username === admin.username;
  const passOk = await verifyPassword(password, admin);
  if (!userOk || !passOk) return fail();
  // 旧版单轮 SHA-256 哈希在登录成功时顺手升级为 PBKDF2（盐不变，其余字段原样）
  if (isLegacyHash(admin)) {
    try {
      const hash = await hashPassword(password, admin.salt);
      await env.NAV_KV.put('admin', JSON.stringify({ ...admin, hash }));
    } catch { /* 升级失败不阻塞登录，下次再试 */ }
  }
  rlClear(ip);
  const token = await createSession(env);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
}
