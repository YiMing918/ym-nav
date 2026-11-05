// /api/wallpaper — custom background image stored in KV (key "wallpaper_img").
// GET    → the stored image bytes (public: it is the site's background)
// POST   → upload/replace (admin only, raw image body, max ~4.5 MB)
// DELETE → remove (admin only)
import { json, isAuthed } from '../_auth.js';

const MAX_BYTES = 4.5 * 1024 * 1024;

export async function onRequestGet({ env }) {
  if (!env.NAV_KV) return json({ error: 'KV binding NAV_KV missing' }, 500);
  const buf = await env.NAV_KV.get('wallpaper_img', 'arrayBuffer');
  if (!buf) return json({ error: 'no wallpaper' }, 404);
  const type = (await env.NAV_KV.get('wallpaper_type')) || 'image/jpeg';
  return new Response(buf, {
    status: 200,
    headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=600' },
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.NAV_KV) return json({ error: 'KV binding NAV_KV missing' }, 500);
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, 401);
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return json({ error: 'empty body' }, 400);
  if (buf.byteLength > MAX_BYTES) return json({ error: 'image too large' }, 413);
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim();
  if (!type.startsWith('image/')) return json({ error: 'not an image' }, 415);
  await env.NAV_KV.put('wallpaper_img', buf);
  await env.NAV_KV.put('wallpaper_type', type);
  return json({ success: true, bytes: buf.byteLength, type });
}

export async function onRequestDelete({ request, env }) {
  if (!env.NAV_KV) return json({ error: 'KV binding NAV_KV missing' }, 500);
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, 401);
  await env.NAV_KV.delete('wallpaper_img');
  await env.NAV_KV.delete('wallpaper_type');
  return json({ success: true });
}
