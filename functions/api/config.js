// GET  /api/config  -> { config, clicks, authed, needsSetup }
// POST /api/config  -> save whole config (login required)
import { json, getAdmin, isAuthed } from '../_auth.js';

const DEFAULT_CONFIG = {
  version: 1,
  settings: {
    siteName: '我的导航',
    siteNameEn: 'My Nav',
    wallpaper: '',
    theme: 'auto',
    colsDesktop: 5,
    colsMobile: 3,
    showFrequent: true,
    openInNewTab: true,
  },
  sections: [],
};

export async function onRequestGet({ request, env }) {
  const raw = await env.NAV_KV.get('site_config');
  let config = DEFAULT_CONFIG;
  if (raw) {
    try { config = JSON.parse(raw); } catch { /* keep default */ }
  }
  let clicks = {};
  const rawClicks = await env.NAV_KV.get('clicks');
  if (rawClicks) {
    try { clicks = JSON.parse(rawClicks); } catch { /* ignore */ }
  }
  const admin = await getAdmin(env);
  const authed = await isAuthed(request, env);
  if (!authed) {
    // Private sections and private links never leave the server for anonymous
    // visitors: they (and their click counts) are stripped here, not just hidden in the UI.
    config = {
      ...config,
      sections: (config.sections || [])
        .filter((s) => !s.private)
        .map((s) => ({ ...s, links: (s.links || []).filter((l) => !l.private) })),
    };
    // 天气兜底坐标只发粗化版：fallbackGeo 原样下发时，管理员填多精确
    // 访客就看多精确（填到小区就是住址级泄露）。匿名侧粗化到 0.1°
    //（约 11km，城市级天气完全够用），登录后仍是原值。
    const fg = config.settings && config.settings.fallbackGeo;
    if (fg && typeof fg.lat === 'number' && typeof fg.lon === 'number') {
      config = {
        ...config,
        settings: {
          ...config.settings,
          fallbackGeo: { ...fg, lat: Math.round(fg.lat * 10) / 10, lon: Math.round(fg.lon * 10) / 10 },
        },
      };
    }
    const visibleIds = new Set(config.sections.flatMap((s) => (s.links || []).map((l) => l.id)));
    clicks = Object.fromEntries(Object.entries(clicks).filter(([id]) => visibleIds.has(id)));
  }
  return json({ config, clicks, authed, needsSetup: !admin });
}

export async function onRequestPost({ request, env }) {
  if (!(await isAuthed(request, env))) {
    return json({ error: 'unauthorized' }, 401);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!body || typeof body !== 'object' || !Array.isArray(body.sections)) {
    return json({ error: 'invalid config: sections array required' }, 400);
  }
  // 结构兜底：导入的旧备份/外来文件里 section 可能缺 links 数组，
  // 原样存进去前端 render 会抛错白屏且难以自救。落库前一律补齐。
  for (const s of body.sections) {
    if (s && typeof s === 'object' && !Array.isArray(s.links)) s.links = [];
  }
  // Link URLs render as <a href> in the page: script-bearing schemes must
  // never reach storage, no matter which client sent them.
  for (const s of body.sections) {
    for (const l of (s && s.links) || []) {
      if (l && /^\s*(javascript|data|vbscript|file)\s*:/i.test(String(l.url || ''))) {
        return json({ error: 'link url scheme not allowed' }, 400);
      }
    }
  }
  // Optimistic concurrency: clients that loaded the config send back the
  // updatedAt they loaded (baseUpdatedAt). If the stored config has moved
  // on since (another device saved in between), refuse instead of letting
  // the stale copy silently overwrite the newer one. Clients that send
  // no baseUpdatedAt (older builds) keep the previous behaviour.
  const raw = await env.NAV_KV.get('site_config');
  let storedUpdatedAt = null;
  if (raw) { try { storedUpdatedAt = JSON.parse(raw).updatedAt || null; } catch { /* unparsable stored config: no baseline */ } }
  if (body.baseUpdatedAt != null && storedUpdatedAt && body.baseUpdatedAt !== storedUpdatedAt) {
    return json({ error: 'conflict', updatedAt: storedUpdatedAt }, 409);
  }
  delete body.baseUpdatedAt;
  // Never let credentials live inside the site config.
  delete body.adminPwd;
  delete body.admin;
  body.version = 1;
  body.updatedAt = new Date().toISOString();
  await env.NAV_KV.put('site_config', JSON.stringify(body));
  return json({ ok: true, updatedAt: body.updatedAt });
}
