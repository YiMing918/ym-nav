// Shared helpers for YM Nav (Cloudflare Pages Functions)
// KV binding required: NAV_KV
// KV keys: "site_config" (the whole site JSON), "clicks" ({linkId: count}),
//          "admin" ({salt, hash}), "sess:<token>" (login sessions)

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

export async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(salt + '::' + password);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
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

export async function isAuthed(request, env) {
  const token = sessionToken(request);
  if (!token) return false;
  const v = await env.NAV_KV.get('sess:' + token);
  return !!v;
}

export async function createSession(env) {
  const token = randomHex(24);
  await env.NAV_KV.put('sess:' + token, '1', { expirationTtl: 7 * 24 * 3600 });
  return token;
}

export function sessionCookie(token) {
  return `ymnav=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}`;
}
