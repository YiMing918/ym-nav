// POST /api/click { id }            -> +1 click for one link (legacy single report)
// POST /api/click { items: {id:n} } -> batched report: the page accumulates
// clicks client-side and flushes every few seconds / on page hide, so a
// burst of clicks costs ONE KV write instead of one write per click.
// Both shapes only count ids that exist in the config (an arbitrary id
// must not be able to grow the clicks map or pollute the "frequent" area).
import { json } from '../_auth.js';
import { rateLimited } from '../_ssrf.js';

const MAX_ITEMS = 100;  // distinct links per flush
const MAX_PER_ITEM = 5; // clicks per link per flush (was 100: an anonymous
                        // caller could inflate any link's "frequent" rank
                        // by +100 per request; a real flush never carries
                        // more than a couple of clicks per link)

export async function onRequestPost({ request, env }) {
  // 本端点匿名可调且每个有效请求固定写 1 次 KV——此前零限流，循环
  // POST 1000 次就能烧完全账号当天的 KV 写额度（2026-11-12 事故的
  // 同款形状），顺带刷爆任意链接的计数。复用现成内存限流：正常
  // 前端 20 秒才 flush 一次，30 次/15 分钟绰绰有余；计数仍只在内存，
  // 不为限流本身再写 KV。
  if (await rateLimited(env, request, { scope: 'click', limit: 30 })) {
    return json({ error: 'too many attempts, try again in 15 minutes' }, 429);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  // Normalize both shapes to an { id: delta } map.
  const delta = {};
  let singleId = null;
  if (body && typeof body.items === 'object' && body.items !== null) {
    for (const [k, v] of Object.entries(body.items)) {
      const n = Math.floor(Number(v));
      if (k && k.length <= 100 && Number.isFinite(n) && n > 0) delta[k] = Math.min(n, MAX_PER_ITEM);
      if (Object.keys(delta).length >= MAX_ITEMS) break;
    }
  } else {
    singleId = String((body && body.id) || '');
    if (!singleId || singleId.length > 100) return json({ error: 'bad id' }, 400);
    delta[singleId] = 1;
  }
  if (!Object.keys(delta).length) return json({ error: 'bad id' }, 400);
  // 只给配置里真实存在的链接计数：任意 id 无限自增会撑大 clicks 并污染「常用」区
  let validIds = null;
  const rawCfg = await env.NAV_KV.get('site_config');
  if (rawCfg) {
    try {
      const cfg = JSON.parse(rawCfg);
      validIds = new Set();
      for (const s of cfg.sections || []) for (const l of s.links || []) validIds.add(l.id);
    } catch { /* 配置损坏时拒绝计数，比污染数据稳妥 */ }
  }
  if (!validIds) return json({ error: 'unknown id' }, 400);
  let clicks = {};
  const raw = await env.NAV_KV.get('clicks');
  if (raw) {
    try { clicks = JSON.parse(raw); } catch { /* ignore */ }
  }
  let applied = 0;
  for (const [id, n] of Object.entries(delta)) {
    if (!validIds.has(id)) continue;
    clicks[id] = (clicks[id] || 0) + n;
    applied++;
  }
  if (!applied) return json({ error: 'unknown id' }, 400);
  await env.NAV_KV.put('clicks', JSON.stringify(clicks));
  const out = { ok: true };
  if (singleId) out.count = clicks[singleId];
  return json(out);
}
