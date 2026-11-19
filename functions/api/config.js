// GET  /api/config  -> { config, clicks, authed, needsSetup }
// POST /api/config  -> save whole config (login required)
import { json, getAdmin, isAuthed, kvMissing, sameOriginOk } from '../_auth.js';
const DEFAULT_CONFIG = { version: 1, settings: { siteName: '我的导航', siteNameEn: 'My Nav', wallpaper: '', theme: 'auto', colsDesktop: 5, colsMobile: 3, showFrequent: true, openInNewTab: true }, sections: [] };
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const HEX_COLOR = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?$/;
const ICON_CLASS = /^fa-[a-z0-9-]+( fa-[a-z0-9-]+)*$/;
export function isSafeLinkUrl(raw) {
  if (typeof raw !== 'string') return false;
  if (/[\u0000-\u0020\u007f]/.test(raw)) return false;
  let u; try { u = new URL(raw); } catch { return false; }
  return u.protocol === 'http:' || u.protocol === 'https:';
}
function validateConfig(body) {
  if (!Array.isArray(body.sections)) return 'sections array required';
  if (body.sections.length > 200) return 'too many sections';
  const secIds = new Set(); const linkIds = new Set(); let linkTotal = 0;
  for (const s of body.sections) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return 'section must be an object';
    if (typeof s.id !== 'string' || !s.id || s.id.length > 100) return 'section id required';
    if (secIds.has(s.id)) return 'duplicate section id: ' + s.id;
    secIds.add(s.id);
    if (!Array.isArray(s.links)) s.links = [];
    if (s.links.length > 2000) return 'too many links in section';
    for (const k of ['title', 'titleEn']) if (s[k] != null && (typeof s[k] !== 'string' || s[k].length > 200)) return 'section ' + k + ' invalid';
    if (s.accent != null && s.accent !== '' && !HEX_COLOR.test(String(s.accent))) s.accent = '#6366f1';
    if (s.icon != null && s.icon !== '' && !ICON_CLASS.test(String(s.icon))) s.icon = 'fa-solid fa-folder';
    for (const l of s.links) {
      if (!l || typeof l !== 'object' || Array.isArray(l)) return 'link must be an object';
      if (typeof l.id !== 'string' || !l.id || l.id.length > 100) return 'link id required';
      if (linkIds.has(l.id)) return 'duplicate link id: ' + l.id;
      linkIds.add(l.id); linkTotal++;
      if (typeof l.url !== 'string' || l.url.length > 2048) return 'link url invalid';
      if (l.url && !isSafeLinkUrl(l.url)) return 'link url scheme not allowed';
      for (const k of ['name', 'nameEn', 'desc']) if (l[k] != null && (typeof l[k] !== 'string' || l[k].length > 500)) return 'link ' + k + ' invalid';
      if (l.color != null && l.color !== '' && !HEX_COLOR.test(String(l.color))) delete l.color;
      if (l.icon != null && l.icon !== '' && !ICON_CLASS.test(String(l.icon))) delete l.icon;
    }
  }
  if (linkTotal > 10000) return 'too many links';
  const st = body.settings;
  if (st != null) {
    if (typeof st !== 'object' || Array.isArray(st)) return 'settings must be an object';
    for (const k of ['siteName', 'siteNameEn']) if (st[k] != null && (typeof st[k] !== 'string' || st[k].length > 200)) return 'settings ' + k + ' invalid';
    if (st.wallpaper != null && st.wallpaper !== '') {
      const w = String(st.wallpaper);
      if (w.length > 2048 || /[\u0000-\u0020\u007f]/.test(w)) return 'wallpaper url invalid';
      if (!w.startsWith('/') && !isSafeLinkUrl(w)) return 'wallpaper url scheme not allowed';
    }
  }
  return null;
}
export async function onRequestGet({ request, env }) {
  if (kvMissing(env)) return json({ error: 'KV binding NAV_KV missing' }, 500);
  const raw = await env.NAV_KV.get('site_config');
  let config = DEFAULT_CONFIG;
  if (raw) { try { const p = JSON.parse(raw); if (p && typeof p === 'object' && !Array.isArray(p)) config = p; } catch { } }
  if (!Array.isArray(config.sections)) config = { ...config, sections: [] };
  if (!config.settings || typeof config.settings !== 'object') config = { ...config, settings: {} };
  let clicks = {};
  const rawClicks = await env.NAV_KV.get('clicks');
  if (rawClicks) { try { const c = JSON.parse(rawClicks); if (c && typeof c === 'object' && !Array.isArray(c)) clicks = c; } catch { } }
  const admin = await getAdmin(env);
  const authed = await isAuthed(request, env);
  if (!authed) {
    config = { ...config, sections: config.sections.filter((s) => s && typeof s === 'object' && !s.private).map((s) => ({ ...s, links: (Array.isArray(s.links) ? s.links : []).filter((l) => l && typeof l === 'object' && !l.private) })) };
    const fg = config.settings && config.settings.fallbackGeo;
    if (fg && typeof fg.lat === 'number' && typeof fg.lon === 'number') {
      config = { ...config, settings: { ...config.settings, fallbackGeo: { ...fg, lat: Math.round(fg.lat * 10) / 10, lon: Math.round(fg.lon * 10) / 10 } } };
    }
    const visibleIds = new Set(config.sections.flatMap((s) => (s.links || []).map((l) => l.id)));
    clicks = Object.fromEntries(Object.entries(clicks).filter(([id]) => visibleIds.has(id)));
  }
  return json({ config, clicks, authed, needsSetup: !admin });
}
export async function onRequestPost({ request, env }) {
  if (kvMissing(env)) return json({ error: 'KV binding NAV_KV missing' }, 500);
  if (!sameOriginOk(request)) return json({ error: 'cross-origin request rejected' }, 403);
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, 401);
  const cl = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) return json({ error: 'config too large' }, 413);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid config' }, 400);
  if (JSON.stringify(body).length > MAX_BODY_BYTES) return json({ error: 'config too large' }, 413);
  const verr = validateConfig(body);
  if (verr) return json({ error: 'invalid config: ' + verr }, 400);
  const raw = await env.NAV_KV.get('site_config');
  let storedUpdatedAt = null;
  if (raw) {
    try { storedUpdatedAt = JSON.parse(raw).updatedAt || null; }
    catch { return json({ error: 'stored config corrupted; refusing to overwrite (restore site_config in KV first)' }, 500); }
  }
  if (body.baseUpdatedAt != null && storedUpdatedAt && body.baseUpdatedAt !== storedUpdatedAt) return json({ error: 'conflict', updatedAt: storedUpdatedAt }, 409);
  delete body.baseUpdatedAt; delete body.adminPwd; delete body.admin;
  body.version = 1; body.updatedAt = new Date().toISOString();
  try { await env.NAV_KV.put('site_config', JSON.stringify(body)); } catch { return json({ error: 'KV write failed' }, 500); }
  return json({ ok: true, updatedAt: body.updatedAt });
}
