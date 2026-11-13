// Shared helpers for YM Nav (Cloudflare Pages Functions)
// KV binding required: NAV_KV
// KV keys: "site_config" (the whole site JSON), "clicks" ({linkId: count}),
//          "admin" ({username, salt, hash, ver}), "sess:<token>" (login
//          sessions; the stored value is "v<admin.ver>" so that changing
//          the password — which bumps ver — kills every older session)

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

// 口令哈希：新哈希一律 PBKDF2-SHA256 100,000 轮。此前是单轮
// SHA-256(salt::密码)：盐有，但对离线爆破毫无阻力——KV 一旦泄露，
// 统一密码可被快速撞开。旧哈希保持可验，登录成功时由 login.js
// 顺手升级（isLegacyHash），站长无感、无需改密码。
const PBKDF2_ITER = 100000;

async function pbkdf2hex(password, salt, iter) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: iter }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function legacyHash(password, salt) {
  const data = new TextEncoder().encode(salt + '::' + password);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hashPassword(password, salt) {
  return 'pbkdf2:' + PBKDF2_ITER + ':' + (await pbkdf2hex(password, salt, PBKDF2_ITER));
}

export function isLegacyHash(admin) {
  return !!(admin && admin.hash && !String(admin.hash).startsWith('pbkdf2:'));
}

export async function verifyPassword(password, admin) {
  if (!admin || !admin.salt || !admin.hash) return false;
  if (String(admin.hash).startsWith('pbkdf2:')) {
    const parts = String(admin.hash).split(':');
    const iter = parseInt(parts[1], 10) || PBKDF2_ITER;
    return timingSafeEq(await pbkdf2hex(password, admin.salt, iter), parts[2] || '');
  }
  return timingSafeEq(await legacyHash(password, admin.salt), admin.hash);
}

export function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getAdmin(env) {
  const raw = await env.NAV_KV.get('admin');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function sessionToken(request) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)ymnav=([a-zA-Z0-9-]+)/);
  return m ? m[1] : null;
}

// Session version of an admin record. Records written before versioning
// existed have no ver field and count as v1.
export function adminVer(admin) {
  const v = admin ? parseInt(admin.ver, 10) : NaN;
  return Number.isInteger(v) && v >= 1 ? v : 1;
}

export async function isAuthed(request, env) {
  const token = sessionToken(request);
  if (!token) return false;
  const v = await env.NAV_KV.get('sess:' + token);
  if (!v) return false;
  const expect = adminVer(await getAdmin(env));
  if (v === 'v' + expect) return true;
  // Legacy sessions stored a plain '1' before versioning; they count as v1
  // and die on the first password change like everyone else.
  return expect === 1 && v === '1';
}

export async function createSession(env) {
  const token = randomHex(24);
  await env.NAV_KV.put('sess:' + token, 'v' + adminVer(await getAdmin(env)), { expirationTtl: 7 * 24 * 3600 });
  return token;
}

export function sessionCookie(token) {
  return `ymnav=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}`;
}
