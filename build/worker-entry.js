// build/worker-entry.js — 「_worker.js 高级模式包」的构建入口（本文件不要直接部署）
//
// 为什么需要它：Cloudflare 控制台的「上传资产 / 拖拽」部署**不会编译 functions/
// 文件夹**（官方文档明示），把普通部署包直传上去会得到一个网页能开、但 /api/*
// 全部被单页回退吞掉的坏站（登录、存数据全坏）。官方确认根目录的单个
// `_worker.js` 在拖拽上传下受支持，所以打包时用 esbuild 把 functions/ 的原
// 处理函数合成一个 _worker.js，原函数源码一字不改，逻辑还是同一套。
//
// 构建命令（release-pack 工作流里执行，本地复现也是这一条）：
//   esbuild build/worker-entry.js --bundle --format=esm \
//     --platform=neutral --target=es2022 --outfile=_worker.js
//
// 路由语义与 functions 文件路由逐条对齐（三条都是实测口径）：
//   1) 尾斜杠等价：/api/config/ 与 /api/config 一样进函数（匹配前去掉一个尾斜杠）；
//   2) 只对精确的 (路径, 方法) 对分发，方法未命中一律落回静态层——与原版一致
//      （如 GET /api/login 回首页、POST /api/icon 回静态层 405）；
//   3) HEAD 不映射到 GET 处理函数（原版 HEAD /api/config 落静态层回首页）。
// 静态与回退：未命中走 env.ASSETS.fetch；资产未命中且是 GET/HEAD 时，按 Pages
// 在无 404.html 时的单页回退口径回 /index.html（原版线上即如此）。
// _headers：高级模式下平台不再应用 _headers。原版口径是「_headers 只管静态
// 响应、不管函数响应」（线上实测：函数 JSON 响应不带这四个头），故本入口只给
// 资产层出来的响应补 _headers 的 /* 规则四个安全头，函数响应原样返回。

import { onRequestGet as configGet, onRequestPost as configPost } from '../functions/api/config.js';
import { onRequestPost as setupPost } from '../functions/api/setup.js';
import { onRequestPost as loginPost } from '../functions/api/login.js';
import { onRequestPost as logoutPost } from '../functions/api/logout.js';
import { onRequestPost as clickPost } from '../functions/api/click.js';
import { onRequestPost as probePost } from '../functions/api/probe.js';
import { onRequestGet as iconGet } from '../functions/api/icon.js';
import {
  onRequestGet as wallpaperGet,
  onRequestPost as wallpaperPost,
  onRequestDelete as wallpaperDelete,
} from '../functions/api/wallpaper.js';

const ROUTES = {
  '/api/config': { GET: configGet, POST: configPost },
  '/api/setup': { POST: setupPost },
  '/api/login': { POST: loginPost },
  '/api/logout': { POST: logoutPost },
  '/api/click': { POST: clickPost },
  '/api/probe': { POST: probePost },
  '/api/icon': { GET: iconGet },
  '/api/wallpaper': { GET: wallpaperGet, POST: wallpaperPost, DELETE: wallpaperDelete },
};

// 与仓库根 _headers 的 /* 规则一致（改 _headers 时同步改这里）
const STATIC_HEADERS = [
  ['X-Frame-Options', 'DENY'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'no-referrer'],
  ['Content-Security-Policy', "frame-ancestors 'none'"],
];

async function serveAsset(request, env, url) {
  let resp = await env.ASSETS.fetch(request);
  if (resp.status === 404 && (request.method === 'GET' || request.method === 'HEAD')) {
    const idx = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin)));
    if (idx.ok) {
      resp = new Response(request.method === 'HEAD' ? null : idx.body, {
        status: 200,
        headers: idx.headers,
      });
    }
  }
  const headers = new Headers(resp.headers);
  for (const [k, v] of STATIC_HEADERS) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const route = ROUTES[path];
    const handler = route && route[request.method];
    if (handler) {
      return handler({
        request,
        env,
        params: {},
        waitUntil: ctx.waitUntil.bind(ctx),
        next: () => serveAsset(request, env, url),
      });
    }
    return serveAsset(request, env, url);
  },
};
