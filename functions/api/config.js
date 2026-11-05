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
  // Never let credentials live inside the site config.
  delete body.adminPwd;
  delete body.admin;
  body.version = 1;
  body.updatedAt = new Date().toISOString();
  await env.NAV_KV.put('site_config', JSON.stringify(body));
  return json({ ok: true });
}
