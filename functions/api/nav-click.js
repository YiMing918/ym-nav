// POST /api/click { id } -> increments the click counter for a link (for the auto "frequent" section)
import { json } from '../_auth.js';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const id = String(body.id || '');
  if (!id || id.length > 100) return json({ error: 'bad id' }, 400);
  // 只给配置里真实存在的链接计数：任意 id 无限自增会撑大 clicks 并污染「常用」区
  let valid = false;
  const rawCfg = await env.NAV_KV.get('site_config');
  if (rawCfg) {
    try {
      const cfg = JSON.parse(rawCfg);
      valid = (cfg.sections || []).some((s) => (s.links || []).some((l) => l.id === id));
    } catch { /* 配置损坏时拒绝计数，比污染数据稳妥 */ }
  }
  if (!valid) return json({ error: 'unknown id' }, 400);
  let clicks = {};
  const raw = await env.NAV_KV.get('clicks');
  if (raw) {
    try { clicks = JSON.parse(raw); } catch { /* ignore */ }
  }
  clicks[id] = (clicks[id] || 0) + 1;
  await env.NAV_KV.put('clicks', JSON.stringify(clicks));
  return json({ ok: true, count: clicks[id] });
}
