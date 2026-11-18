// ym-nav 会话键哈希定向测试（node tests/auth-session.test.mjs）
// 覆盖 Chief 审计 #7：会话 KV 键由 sess:<token> 改为 sess:<sha256(token)>——
// KV 里不出现令牌原文作键；Cookie（原文）照常鉴权；退出删的是哈希键。
import { createHash } from 'node:crypto';
import { createSession, isAuthed } from '../functions/_auth.js';
import { onRequestPost as logout } from '../functions/api/logout.js';

class KVShim {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, String(v)); }
  async delete(k) { this.map.delete(k); }
}
const env = { NAV_KV: new KVShim() };
await env.NAV_KV.put('admin', JSON.stringify({ username: 'boss', salt: 's', hash: 'x', ver: 2 }));

let pass = 0, failN = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, extra); } };

const token = await createSession(env);
const expectKey = 'sess:' + createHash('sha256').update(token).digest('hex');
chk('会话以哈希键落库', env.NAV_KV.map.has(expectKey), [...env.NAV_KV.map.keys()].join(','));
chk('KV 键里不含令牌原文', ![...env.NAV_KV.map.keys()].some(k => k.includes(token)));

const req = new Request('https://nav.test/', { headers: { Cookie: `ymnav=${token}` } });
chk('Cookie 原文照常鉴权', (await isAuthed(req, env)) === true);
await logout({ request: req, env });
chk('退出后哈希键已删', !env.NAV_KV.map.has(expectKey));
chk('退出后鉴权为 false', (await isAuthed(req, env)) === false);

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
