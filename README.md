# YM Nav · 个人导航

一个为自己使用习惯写的个人导航站：Cloudflare Pages + Functions + KV，全部免费额度内运行。

## 特点

- **分类即顺序**：数据按分类存储，「全部」页永远按分类成块展示；在某个分类里加网站，它自动排在该分类末尾，不用管任何排序编号。
- **本地 / 挂梯徽标**：可达性是链接的正式字段（`badge: local / proxy`），卡片右上角彩色小标签，不再拼在名字里。
- **真后台鉴权**：管理员密码以加盐 SHA-256 哈希存放在 KV 独立 key，登录用 HttpOnly 会话 Cookie（7 天），改数据接口一律验会话——不是前端摆设。
- **常去自动区**：点击计数（cf-nav 的点子），打开多的网站自动排到首页「常去」区。
- **顶部搜索**：站内实时过滤 + 百度 / Google / Bing / GitHub 搜索引擎切换（iori 的点子）。
- **老站的好习惯都在**：中英双语名、分类图标与主题色、标准 / 宽卡片、图标 / 纯文字两种链接样式、壁纸、深浅色、双击站名进后台。
- **收藏小工具**：后台「工具」里有书签小工具（bookmarklet），在任何网页一键收藏进本站（cloudmark 的点子）；键盘 `/` 聚焦搜索、`Esc` 清空。
- **数据自由**：JSON 整体备份 / 恢复，CSV（区域,网站名称,英文名称,网址,徽标）追加导入导出，浏览器书签 HTML 导入导出。KV 读不到时自动用浏览器本地缓存顶上。

## 数据结构

整站数据是 KV 里的一份 JSON（key `site_config`）：

```jsonc
{
  "version": 1,
  "settings": { "siteName": "...", "siteNameEn": "...", "wallpaper": "", "theme": "auto",
                "colsDesktop": 5, "colsMobile": 3, "showFrequent": true, "openInNewTab": true },
  "sections": [
    { "id": "sec_x", "title": "常用推荐", "titleEn": "Recommended",
      "icon": "fa-solid fa-star", "accent": "#6366f1", "layout": "card", "linkStyle": "icon",
      "links": [ { "id": "link_x", "name": "哔哩哔哩", "nameEn": "Bilibili",
                   "url": "https://www.bilibili.com/", "icon": "fab fa-bilibili",
                   "color": "", "badge": "local" } ] }
  ]
}
```

其它 KV key：`admin`（密码盐+哈希）、`sess:<token>`（会话）、`clicks`（点击计数）。

## 部署（Cloudflare Pages）

1. 建一个 Pages 项目：连本仓库（构建命令留空，输出目录 `/`），或用「直接上传」传打包好的 zip。
2. 新建一个 KV 命名空间，在 Pages 项目 设置 → 绑定 里绑为变量名 **`NAV_KV`**（改完绑定要重新部署一次才生效）。
3. 部署完成后打开站点，双击页面的大标题（站名）——首次会让你设置管理员账号和密码，设完自动登录。
4. 后台「数据」里导入种子 JSON（或从零开始加）。

## 目录

- `index.html` — 全部前端（单文件）
- `functions/_auth.js` — 鉴权与工具函数
- `functions/api/config.js` — 读 / 存整站数据
- `functions/api/login.js` / `logout.js` / `setup.js` — 登录、退出、首次设密与改密码
- `functions/api/click.js` — 点击计数
