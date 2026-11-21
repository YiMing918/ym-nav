// ym-nav 鉴权 fail-closed 定向测试（node tests/auth-failclosed.test.mjs）
// 覆盖第三轮审计 C 条：admin 记录缺失/损坏时 isAuthed 回落 ver=1 放行旧
// 会话，POST /api/config 能写配置；且删键重建 admin 时 ver 仍写 1，旧
// 会话在重设密码后原地复活。修复口径：admin 缺失/损坏一律拒绝；重建
// 写随机 ver 让旧会话全灭。另带正常路径回归：首设、登录、改密、无 ver
// 的老记录（版本化之前写的）照常工作。
import { createSession, isAuthed, sessionKey, hashPassword, randomHex } from '../functions/_auth.js';
import { onRequestPost as setupPost } from '../functions/api/setup.js';
import { onRequestPost as loginPost } from '../functions/api/login.js';
import { onRequestPost as configPost } from '../functions/api/config.js';

class KVShim {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, String(v)); }
  async delete(k) { this.map.delete(k); }
}
const newEnv = () => ({ NAV_KV: new KVShim() });

let pass = 0, failN = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, extra); } };

function req(path, { body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = `ymnav=${cookie}`;
  return new Request('https://nav.test' + path, { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined });
}
const cookieOf = (resp) => {
  const sc = resp.headers.get('Set-Cookie') || '';
  const m = sc.match(/ymnav=([a-zA-Z0-9-]+)/);
  return m ? m[1] : null;
};
async function makeAdmin(env, password, ver) {
  const salt = randomHex(16);
  const rec = { username: 'boss', salt, hash: await hashPassword(password, salt) };
  if (ver !== undefined) rec.ver = ver;
  await env.NAV_KV.put('admin', JSON.stringify(rec));
  return rec;
}
const saveConfig = (env, token) => configPost({ request: req('/api/config', { body: { sections: [] }, cookie: token }), env });

// ---------- 1. admin 缺失：旧 v1 会话必须被拒 ----------
{
  const env = newEnv();
  await makeAdmin(env, 'pw123456', 1);
  const token = await createSession(env); // 存量会话，值 'v1'
  chk('前置：admin 在时旧会话可用', (await isAuthed(req('/api/config', { cookie: token }), env)) === true);
  await env.NAV_KV.delete('admin');
  chk('admin 缺失：isAuthed 拒绝旧 v1 会话', (await isAuthed(req('/api/config', { cookie: token }), env)) === false);
  const resp = await saveConfig(env, token);
  chk('admin 缺失：POST /api/config 返回 401', resp.status === 401, 'got ' + resp.status);
  chk('admin 缺失：site_config 没有被写', !(await env.NAV_KV.get('site_config')));
}
// ---------- 2. admin 缺失：更老的纯 '1' 会话同样被拒 ----------
{
  const env = newEnv();
  await env.NAV_KV.put(await sessionKey('legacytok'), '1');
  chk("admin 缺失：纯 '1' 老会话被拒", (await isAuthed(req('/api/config', { cookie: 'legacytok' }), env)) === false);
}
// ---------- 3. admin 损坏（坏 JSON）：旧会话被拒、写配置 401 ----------
{
  const env = newEnv();
  await makeAdmin(env, 'pw123456', 1);
  const token = await createSession(env);
  await env.NAV_KV.put('admin', '{{{not json');
  chk('admin 损坏(坏JSON)：isAuthed 拒绝', (await isAuthed(req('/api/config', { cookie: token }), env)) === false);
  const resp = await saveConfig(env, token);
  chk('admin 损坏(坏JSON)：POST /api/config 返回 401', resp.status === 401, 'got ' + resp.status);
}
// ---------- 4. admin 损坏（JSON 能解但缺 salt/hash）：旧会话被拒 ----------
{
  const env = newEnv();
  await makeAdmin(env, 'pw123456', 1);
  const token = await createSession(env);
  await env.NAV_KV.put('admin', JSON.stringify({ username: 'boss' }));
  chk('admin 损坏(缺字段)：isAuthed 拒绝', (await isAuthed(req('/api/config', { cookie: token }), env)) === false);
}
// ---------- 5. 删键重建：旧会话全灭、新会话可用 ----------
{
  const env = newEnv();
  await makeAdmin(env, 'oldpw123', 1);
  const loginResp = await loginPost({ request: req('/api/login', { body: { username: 'boss', password: 'oldpw123' } }), env });
  const oldToken = cookieOf(loginResp);
  chk('前置：旧密码登录成功', loginResp.status === 200 && !!oldToken, 'got ' + loginResp.status);
  await env.NAV_KV.delete('admin'); // 站长删键找回密码
  const setupResp = await setupPost({ request: req('/api/setup', { body: { username: 'boss', password: 'newpw123' } }), env });
  chk('删键后重建 admin 成功', setupResp.status === 200, 'got ' + setupResp.status);
  const rec = JSON.parse(await env.NAV_KV.get('admin'));
  chk('重建的 admin ver 不再是 1', rec.ver !== 1, 'ver=' + rec.ver);
  chk('重建后旧会话失效', (await isAuthed(req('/api/config', { cookie: oldToken }), env)) === false);
  const newToken = cookieOf(setupResp);
  chk('重建发的新会话可用', !!newToken && (await isAuthed(req('/api/config', { cookie: newToken }), env)) === true);
  const relogin = await loginPost({ request: req('/api/login', { body: { username: 'boss', password: 'newpw123' } }), env });
  chk('新密码可登录', relogin.status === 200, 'got ' + relogin.status);
}
// ---------- 6. 首次设置（全新空 KV）：流程不依赖 isAuthed 放行，照常走通 ----------
{
  const env = newEnv();
  const resp = await setupPost({ request: req('/api/setup', { body: { username: 'boss', password: 'pw123456' } }), env });
  chk('首次设置成功', resp.status === 200, 'got ' + resp.status);
  const token = cookieOf(resp);
  chk('首次设置发的新会话可用', !!token && (await isAuthed(req('/api/config', { cookie: token }), env)) === true);
  const save = await saveConfig(env, token);
  chk('首次设置后能写配置', save.status === 200, 'got ' + save.status);
}
// ---------- 7. 正常改密回归：ver 递增、旧会话死、新会话活 ----------
{
  const env = newEnv();
  await makeAdmin(env, 'pw123456', 3);
  const loginResp = await loginPost({ request: req('/api/login', { body: { username: 'boss', password: 'pw123456' } }), env });
  const token = cookieOf(loginResp);
  const chg = await setupPost({ request: req('/api/setup', { body: { oldPassword: 'pw123456', newPassword: 'pw654321' }, cookie: token }), env });
  chk('正常改密成功', chg.status === 200, 'got ' + chg.status);
  chk('改密后旧会话失效', (await isAuthed(req('/api/config', { cookie: token }), env)) === false);
  const newToken = cookieOf(chg);
  chk('改密发的新会话可用', !!newToken && (await isAuthed(req('/api/config', { cookie: newToken }), env)) === true);
}
// ---------- 8. 无 ver 字段的老记录（版本化之前）照常登录、会话可用 ----------
{
  const env = newEnv();
  await makeAdmin(env, 'pw123456', undefined); // 不写 ver
  const loginResp = await loginPost({ request: req('/api/login', { body: { username: 'boss', password: 'pw123456' } }), env });
  const token = cookieOf(loginResp);
  chk('无 ver 老记录可登录', loginResp.status === 200 && !!token, 'got ' + loginResp.status);
  chk('无 ver 老记录的会话可用', (await isAuthed(req('/api/config', { cookie: token }), env)) === true);
}

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
