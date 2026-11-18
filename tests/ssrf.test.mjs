// ym-nav _ssrf.js 定向测试（node tests/ssrf.test.mjs）
// _ssrf.js 的 safeFetch 支持 fetchImpl 注入，全程不发真请求。
// 覆盖：127.0.0.1 / ::1 / 169.254.169.254 直连拦截、公网 302 跳内网逐跳拦截、
// 跳转超上限、readBodyLimited 超长 body 截断、公网正常放行。
import { safeFetch, readBodyLimited, isBlockedHost, SsrfError, MAX_REDIRECTS } from '../functions/_ssrf.js';

let pass = 0, failN = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, extra); } };

async function expectBlocked(name, url, fetchImpl) {
  let calls = 0;
  const impl = fetchImpl || (async () => { calls++; return new Response('x', { status: 200 }); });
  let err = null;
  try { await safeFetch(url, {}, { fetchImpl: impl }); } catch (e) { err = e; }
  chk(name, err instanceof SsrfError && err.code === 'blocked', err ? `${err.name}:${err.code}` : 'no error');
  return calls;
}

// 直连内网/回环/元数据：守卫在发请求前就拦，fetchImpl 一次都不该被调
chk('isBlockedHost(127.0.0.1)', isBlockedHost('127.0.0.1') === true);
chk('isBlockedHost(::1)', isBlockedHost('::1') === true);
chk('isBlockedHost(169.254.169.254)', isBlockedHost('169.254.169.254') === true);
chk('isBlockedHost(93.184.216.34) 放行', isBlockedHost('93.184.216.34') === false);
{
  let calls = 0;
  const impl = async () => { calls++; return new Response('x', { status: 200 }); };
  let err = null;
  try { await safeFetch('http://127.0.0.1:8080/admin', {}, { fetchImpl: impl }); } catch (e) { err = e; }
  chk('safeFetch 127.0.0.1 → blocked 且零请求', err?.code === 'blocked' && calls === 0, `calls=${calls} err=${err?.code}`);
}
{
  let calls = 0;
  const impl = async () => { calls++; return new Response('x', { status: 200 }); };
  let err = null;
  try { await safeFetch('http://[::1]/', {}, { fetchImpl: impl }); } catch (e) { err = e; }
  chk('safeFetch [::1] → blocked 且零请求', err?.code === 'blocked' && calls === 0, `calls=${calls} err=${err?.code}`);
}
{
  let calls = 0;
  const impl = async () => { calls++; return new Response('x', { status: 200 }); };
  let err = null;
  try { await safeFetch('http://169.254.169.254/latest/meta-data/', {}, { fetchImpl: impl }); } catch (e) { err = e; }
  chk('safeFetch 169.254.169.254 → blocked 且零请求', err?.code === 'blocked' && calls === 0, `calls=${calls} err=${err?.code}`);
}

// 公网首跳 302 跳内网：只发第一跳，第二跳在请求前被拦
{
  let calls = 0;
  const impl = async () => { calls++; return new Response('', { status: 302, headers: { location: 'http://192.168.1.1/admin' } }); };
  let err = null;
  try { await safeFetch('https://friend.example.com/', {}, { fetchImpl: impl }); } catch (e) { err = e; }
  chk('公网 302 跳 192.168 → 第二跳请求前被拦', err?.code === 'blocked' && calls === 1, `calls=${calls} err=${err?.code}`);
}

// 跳转超上限
{
  let calls = 0;
  const impl = async () => { calls++; return new Response('', { status: 302, headers: { location: 'https://friend.example.com/next' } }); };
  let err = null;
  try { await safeFetch('https://friend.example.com/', {}, { fetchImpl: impl }); } catch (e) { err = e; }
  chk(`跳转超 ${MAX_REDIRECTS} → too_many_redirects`, err?.code === 'too_many_redirects' && calls === MAX_REDIRECTS + 1, `calls=${calls} err=${err?.code}`);
}

// 公网正常放行
{
  const impl = async () => new Response('hello', { status: 200 });
  const res = await safeFetch('https://friend.example.com/', {}, { fetchImpl: impl });
  chk('公网 200 原样返回', res.status === 200 && (await res.text()) === 'hello');
}

// 超长 body：readBodyLimited 流式截断
{
  const big = new ReadableStream({
    start(c) { const chunk = new Uint8Array(64 * 1024).fill(65); for (let i = 0; i < 32; i++) c.enqueue(chunk); c.close(); },
  });
  const res = new Response(big, { status: 200 });
  let err = null;
  try { await readBodyLimited(res, { maxBytes: 1024 * 1024, timeoutMs: 5000 }); } catch (e) { err = e; }
  chk('2MB body 超 1MB 上限 → body too large', !!err && /too large/.test(err.message), err?.message);
  const small = new Response('tiny', { status: 200 });
  const buf = await readBodyLimited(small, { maxBytes: 1024 * 1024 });
  chk('小 body 正常读完', buf.byteLength === 4);
}

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
