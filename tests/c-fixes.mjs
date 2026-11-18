// ym-nav 对抗复读 C 部分定向测试（node tests/c-fixes.mjs）
//   C-22 点击计数写前重读合并：读完 clicks 后、写回前有并发写进入时，
//        本请求的增量要合并到最新值上，不能把对方的计数整表覆盖。
//   C-29 登录用户名不对时也跑一遍口令哈希拉平耗时（PBKDF2 耗时粗测）。
//   C-28 首次设置写后回读比对：admin 被并发覆盖时 setup 报错、不发会话。
import { hashPassword } from '../functions/_auth.js';
import { onRequestPost as click } from '../functions/api/click.js';
import { onRequestPost as login } from '../functions/api/login.js';
import { onRequestPost as setup } from '../functions/api/setup.js';

class KV {
  constructor() { this.m = new Map(); this.onGet = null; this.onPut = null; }
  async get(k) {
    const v = this.m.has(k) ? this.m.get(k) : null;
    if (this.onGet) { const f = this.onGet; if (f(k)) this.onGet = null; }
    return v;
  }
  async put(k, v) {
    this.m.set(k, String(v));
    if (this.onPut) { const f = this.onPut; if (f(k)) this.onPut = null; }
  }
  async delete(k) { this.m.delete(k); }
}
let pass = 0, failN = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, extra); } };

// ---------- C-22 点击计数合并 ----------
{
  const kv = new KV();
  const env = { NAV_KV: kv };
  kv.m.set('site_config', JSON.stringify({ sections: [{ links: [{ id: 'a' }, { id: 'b' }] }] }));
  kv.m.set('clicks', JSON.stringify({ a: 1 }));
  // 对手：我们第一次读到 clicks 后，并发写把 a 刷到 10（模拟另一请求刚落盘）
  kv.onGet = (k) => {
    if (k !== 'clicks') return false;
    kv.m.set('clicks', JSON.stringify({ a: 10 }));
    return true;
  };
  const req = new Request('https://nav.test/api/click', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '5.5.5.5' },
    body: JSON.stringify({ id: 'a' }),
  });
  const res = await click({ request: req, env });
  const j = await res.json();
  const clicks = JSON.parse(kv.m.get('clicks'));
  chk('C-22 并发计数不丢：10 + 本次 1 = 11', res.status === 200 && clicks.a === 11 && j.count === 11,
    `status=${res.status} clicks=${JSON.stringify(clicks)} resp=${JSON.stringify(j)}`);
  // 无并发时行为不变
  const kv2 = new KV();
  kv2.m.set('site_config', JSON.stringify({ sections: [{ links: [{ id: 'a' }] }] }));
  kv2.m.set('clicks', JSON.stringify({ a: 3 }));
  const req2 = new Request('https://nav.test/api/click', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '5.5.5.6' },
    body: JSON.stringify({ items: { a: 2 } }),
  });
  const res2 = await click({ request: req2, env: { NAV_KV: kv2 } });
  const clicks2 = JSON.parse(kv2.m.get('clicks'));
  chk('C-22 无并发批量上报照常累加', res2.status === 200 && clicks2.a === 5, JSON.stringify(clicks2));
}

// ---------- C-29 登录假哈希拉平耗时 ----------
{
  const kv = new KV();
  const env = { NAV_KV: kv };
  const salt = 'saltZ';
  kv.m.set('admin', JSON.stringify({ username: 'boss', salt, hash: await hashPassword('right-pw', salt), ver: 1 }));
  const t0 = Date.now();
  const res = await login({
    request: new Request('https://nav.test/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '6.6.6.6' },
      body: JSON.stringify({ username: 'not-boss', password: 'right-pw' }),
    }), env,
  });
  const elapsed = Date.now() - t0;
  chk('C-29 错用户名+对密码仍是 403', res.status === 403, 'status=' + res.status);
  chk('C-29 错用户名也跑了口令哈希（≥10ms）', elapsed >= 10, `elapsed=${elapsed}ms`);
}

// ---------- C-28 setup 写后回读比对 ----------
{
  const kv = new KV();
  const env = { NAV_KV: kv };
  kv.onPut = (k) => {
    if (k !== 'admin') return false;
    kv.m.set('admin', JSON.stringify({ username: 'evil', salt: 'othersalt', hash: 'otherhash', ver: 1 }));
    return true;
  };
  const res = await setup({
    request: new Request('https://nav.test/api/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'secret-1' }),
    }), env,
  });
  const j = await res.json();
  chk('C-28 admin 被并发覆盖时 setup 报错', res.status === 409 && !!j.error, `status=${res.status} ${JSON.stringify(j)}`);
  chk('C-28 冲突时不发会话 Cookie', !res.headers.get('Set-Cookie'));
  // 正常路径不受影响
  const kv2 = new KV();
  const res2 = await setup({
    request: new Request('https://nav.test/api/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'secret-1' }),
    }), env: { NAV_KV: kv2 },
  });
  chk('C-28 正常首次设置照常成功', res2.status === 200 && !!(await res2.json()).ok, 'status=' + res2.status);
}

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
