// /api/wallpaper — custom background image stored in KV.
// Storage (low5 fix): image+type now live in ONE key "wallpaper_data"
// (JSON {type, b64}) written with a single put, so a failed write can
// never leave a new image paired with an old type. Legacy two-key
// records (wallpaper_img / wallpaper_type) are still read as fallback.
import { json, isAuthed, sameOriginOk } from '../_auth.js';
const MAX_BYTES = 4.5 * 1024 * 1024;
function b64encode(buf) { let s=''; const b=new Uint8Array(buf); const CH=0x8000; for(let i=0;i<b.length;i+=CH) s+=String.fromCharCode.apply(null,b.subarray(i,i+CH)); return btoa(s); }
function b64decode(s) { const bin=atob(s); const b=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) b[i]=bin.charCodeAt(i); return b.buffer; }
export async function onRequestGet({ env }) {
  if (!env.NAV_KV) return json({ error: 'KV binding NAV_KV missing' }, 500);
  const packed = await env.NAV_KV.get('wallpaper_data');
  if (packed) {
    try { const d = JSON.parse(packed); if (d && d.b64) return new Response(b64decode(d.b64), { status: 200, headers: { 'Content-Type': d.type || 'image/jpeg', 'Cache-Control': 'public, max-age=600', 'X-Content-Type-Options': 'nosniff' } }); } catch { }
  }
  const buf = await env.NAV_KV.get('wallpaper_img', 'arrayBuffer');
  if (!buf) return json({ error: 'no wallpaper' }, 404);
  const type = (await env.NAV_KV.get('wallpaper_type')) || 'image/jpeg';
  return new Response(buf, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=600', 'X-Content-Type-Options': 'nosniff' } });
}
export async function onRequestPost({ request, env }) {
  if (!env.NAV_KV) return json({ error: 'KV binding NAV_KV missing' }, 500);
  if (!sameOriginOk(request)) return json({ error: 'cross-origin request rejected' }, 403);
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, 401);
  const cl = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(cl) && cl > MAX_BYTES) return json({ error: 'image too large' }, 413);
  // Mid6: enforce the cap WHILE reading, not after arrayBuffer() has
  // already pulled the whole body into memory.
  let buf;
  if (request.body && typeof request.body.getReader === 'function') {
    const reader = request.body.getReader(); const chunks=[]; let total=0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > MAX_BYTES) { try { await reader.cancel(); } catch {} return json({ error: 'image too large' }, 413); } chunks.push(value); }
    const out = new Uint8Array(total); let off=0; for (const c of chunks) { out.set(c, off); off+=c.byteLength; } buf = out.buffer;
  } else {
    buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return json({ error: 'image too large' }, 413);
  }
  if (!buf.byteLength) return json({ error: 'empty body' }, 400);
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim();
  if (!type.startsWith('image/')) return json({ error: 'not an image' }, 415);
  if (type === 'image/svg+xml') return json({ error: 'svg not allowed' }, 415);
  await env.NAV_KV.put('wallpaper_data', JSON.stringify({ type, b64: b64encode(buf) }));
  try { await env.NAV_KV.delete('wallpaper_img'); await env.NAV_KV.delete('wallpaper_type'); } catch { }
  return json({ success: true, bytes: buf.byteLength, type });
}
export async function onRequestDelete({ request, env }) {
  if (!env.NAV_KV) return json({ error: 'KV binding NAV_KV missing' }, 500);
  if (!sameOriginOk(request)) return json({ error: 'cross-origin request rejected' }, 403);
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, 401);
  await env.NAV_KV.delete('wallpaper_data');
  await env.NAV_KV.delete('wallpaper_img');
  await env.NAV_KV.delete('wallpaper_type');
  return json({ success: true });
}
