// FlClash 覆写脚本 - qi 全功能版 v3.4 (省额度版, 基于 v3.3 改)
// v3.4: 每个精细分流组的第一位(默认选择)按全网主流推荐地区预置好, 用户需要时自己改:
//       AI=美国(机主指定) / YouTube=香港 / Google=香港 / FCM=故障转移(固定不跳)
//       Telegram=新加坡 / 流媒体=新加坡 / 游戏=日本 / 社交媒体=新加坡
//       支付=美国 / 加密货币=新加坡 / 测速=直连; 另新增「⭐ 优选IP」组:
//       名字里带"优选IP"的节点单独成组(自带自动测速), 各分流组里都能选到它。
//       其余(分组构成/规则/DNS/测速节奏)与 v3.3 完全一致。
// v3.3: 分流规则/分组/节点与 v3.2 完全一致, 只改测速节奏省 Cloudflare 额度:
//       所有自动组间隔 180 秒 -> 600 秒, 并打开懒测 (lazy: true, 只测正在用的组);
//       v3.2 的全主动测速一天能打近 20 万次连接, 会烧光自建节点账号 10 万次/天的免费额度。
// v3.2: 用户不介意费电/费流量, 测速改全主动: 所有自动组每 180 秒测一轮且不懒测,
//       全局自动选择容差 80->50, 选优更跟手; 故障转移/负载均衡同步改 180 秒主动检测。
// v3.1 修复: 保留被节点 dialer-proxy 引用的原始分组(如 ⚡ CF前置 链式前置组),
//           否则家宽等链式节点找不到前置, 内核校验失败导致整个配置无法启动。
// 参考全网主流方案(MyClash / HiClash / ACL4SSR / MetaCubeX)整合:
// 地区分组(通用识别, 换任何订阅可用) + 每地区自动选择 + 故障转移 + 负载均衡
// + 倍率分组(低倍率/高倍率) + 家宽单独成组(保留, 不排除) + 精细分流组
// + 四层去广告(ACL4SSR BanAD/BanProgramAD/BanEasyList + 内置广告分类, 带 UnBan 防误杀)
// + fake-ip 兼容名单(游戏联机/语音通话/时间同步不被假IP弄坏)
// + 冷启动优化(记住选择和 fake-ip 映射) + DNS 分流防污染
// 注意: url-test 测的是响应延迟不是下载带宽, 已做容差优化防乱跳; 真实网速偶尔手测确认。

function main(config) {
  if (!config || !Array.isArray(config.proxies) || config.proxies.length === 0) {
    return config;
  }

  var allNames = config.proxies.map(function (p) { return p && p.name; }).filter(Boolean);

  // 只过滤明显不是节点的信息条目, 其余全保留(包括家宽/住宅)
  var excludeRe = /(剩余流量|流量剩余|距离下次重置|到期|过期|官网|请更新订阅|更新订阅)/i;
  var usable = allNames.filter(function (n) { return !excludeRe.test(n); });
  var pool = usable.length > 0 ? usable : allNames;

  var TEST_URL = "https://cp.cloudflare.com/generate_204";
  function autoGroup(name, members, tolerance) {
    return {
      name: name, type: "url-test", proxies: members,
      url: TEST_URL, interval: 600, tolerance: tolerance || 50,
      lazy: true, timeout: 3000, "max-failed-times": 3
    };
  }

  // ---------- 地区分组(通用识别: 国旗/中文/英文/城市/机场代码/缩写) ----------
  var regions = [
    { label: "🇭🇰 香港",   re: /(🇭🇰|HKG|香港|Hong\s?Kong|(^|[^A-Z])HK([^A-Z]|$))/i },
    { label: "🇹🇼 台湾",   re: /(🇹🇼|TPE|KHH|台湾|臺灣|台北|臺北|高雄|新北|桃园|Taiwan|(^|[^A-Z])TW([^A-Z]|$))/i },
    { label: "🇯🇵 日本",   re: /(🇯🇵|NRT|HND|KIX|NGO|FUK|日本|东京|東京|大阪|名古屋|福冈|Japan|Tokyo|Osaka|(^|[^A-Z])JP([^A-Z]|$))/i },
    { label: "🇰🇷 韩国",   re: /(🇰🇷|ICN|GMP|韩国|韓國|首尔|首爾|釜山|Korea|Seoul|(^|[^A-Z])KR([^A-Z]|$))/i },
    { label: "🇸🇬 新加坡", re: /(🇸🇬|SIN|新加坡|狮城|獅城|Singapore|(^|[^A-Z])SG([^A-Z]|$))/i },
    { label: "🇲🇾 马来西亚", re: /(🇲🇾|KUL|马来西亚|馬來西亞|吉隆坡|Malaysia|Kuala\s?Lumpur|(^|[^A-Z])MY([^A-Z]|$))/i },
    { label: "🇹🇭 泰国",   re: /(🇹🇭|BKK|DMK|泰国|泰國|曼谷|Thailand|Bangkok|(^|[^A-Z])TH([^A-Z]|$))/i },
    { label: "🇻🇳 越南",   re: /(🇻🇳|SGN|HAN|越南|胡志明|河内|河內|Vietnam|(^|[^A-Z])VN([^A-Z]|$))/i },
    { label: "🇮🇩 印尼",   re: /(🇮🇩|CGK|印尼|印度尼西亚|雅加达|Indonesia|Jakarta|(^|[^A-Z])ID([^A-Z]|$))/i },
    { label: "🇵🇭 菲律宾", re: /(🇵🇭|MNL|菲律宾|菲律賓|马尼拉|Philippines|Manila|(^|[^A-Z])PH([^A-Z]|$))/i },
    { label: "🇮🇳 印度",   re: /(🇮🇳|DEL|BOM|印度|孟买|孟買|德里|India|Mumbai|(^|[^A-Z])IN([^A-Z]|$))/i },
    { label: "🇦🇺 澳大利亚", re: /(🇦🇺|SYD|MEL|BNE|澳大利亚|澳洲|悉尼|墨尔本|墨爾本|Australia|Sydney|Melbourne|(^|[^A-Z])AU([^A-Z]|$))/i },
    { label: "🇺🇸 美国",   re: /(🇺🇸|LAX|SFO|SJC|SEA|ORD|DFW|JFK|EWR|IAD|MIA|ATL|美国|美國|洛杉矶|洛杉磯|纽约|紐約|硅谷|矽谷|圣何塞|聖何塞|西雅图|芝加哥|达拉斯|達拉斯|迈阿密|United\s?States|America|Los\s?Angeles|New\s?York|San\s?Jose|Seattle|Chicago|Dallas|(^|[^A-Z])US([^A-Z]|$))/i },
    { label: "🇨🇦 加拿大", re: /(🇨🇦|YYZ|YVR|加拿大|多伦多|多倫多|温哥华|溫哥華|Canada|Toronto|Vancouver|(^|[^A-Z])CA([^A-Z]|$))/i },
    { label: "🇬🇧 英国",   re: /(🇬🇧|LHR|英国|英國|伦敦|倫敦|London|United\s?Kingdom|Britain|(^|[^A-Z])UK([^A-Z]|$)|(^|[^A-Z])GB([^A-Z]|$))/i },
    { label: "🇩🇪 德国",   re: /(🇩🇪|FRA|MUC|德国|德國|法兰克福|法蘭克福|慕尼黑|Germany|Frankfurt|(^|[^A-Z])DE([^A-Z]|$))/i },
    { label: "🇫🇷 法国",   re: /(🇫🇷|CDG|ORY|法国|法國|巴黎|France|Paris|(^|[^A-Z])FR([^A-Z]|$))/i },
    { label: "🇳🇱 荷兰",   re: /(🇳🇱|AMS|荷兰|荷蘭|阿姆斯特丹|Netherlands|Amsterdam|(^|[^A-Z])NL([^A-Z]|$))/i },
    { label: "🇷🇺 俄罗斯", re: /(🇷🇺|SVO|俄罗斯|俄羅斯|莫斯科|Russia|Moscow|(^|[^A-Z])RU([^A-Z]|$))/i },
    { label: "🇹🇷 土耳其", re: /(🇹🇷|IST|土耳其|伊斯坦布尔|Turkey|Istanbul|(^|[^A-Z])TR([^A-Z]|$))/i },
    { label: "🇧🇷 巴西",   re: /(🇧🇷|GRU|巴西|圣保罗|聖保羅|Brazil|Sao\s?Paulo|(^|[^A-Z])BR([^A-Z]|$))/i }
  ];

  var assigned = {};
  var regionSelectors = [];
  var regionGroups = [];
  regions.forEach(function (r) {
    var members = pool.filter(function (n) {
      if (assigned[n]) return false;
      if (r.re.test(n)) { assigned[n] = true; return true; }
      return false;
    });
    if (members.length === 0) return;
    var autoName = r.label + "自动";
    regionGroups.push(autoGroup(autoName, members, 50));
    regionGroups.push({ name: r.label, type: "select", proxies: [autoName].concat(members) });
    regionSelectors.push(r.label);
  });
  var rest = pool.filter(function (n) { return !assigned[n]; });
  if (rest.length > 0) {
    regionGroups.push(autoGroup("🌍 其他自动", rest, 50));
    regionGroups.push({ name: "🌍 其他", type: "select", proxies: ["🌍 其他自动"].concat(rest) });
    regionSelectors.push("🌍 其他");
  }

  // ---------- 属性分组: 家宽 / 倍率(节点照常留在地区组和手动组, 这里是额外入口) ----------
  var extraSelectors = [];
  var extraGroups = [];

  var homeNodes = pool.filter(function (n) { return /(家宽|住宅|residential|家庭宽带)/i.test(n); });
  if (homeNodes.length > 0) {
    extraGroups.push({ name: "🏠 家宽节点", type: "select", proxies: homeNodes.slice() });
    extraSelectors.push("🏠 家宽节点");
  }

  function rateOf(name) {
    var m = name.match(/(?:倍率\s*)?(\d+(?:\.\d+)?)\s*(?:x|倍)/i) || name.match(/[x×]\s*(\d+(?:\.\d+)?)/i);
    return m ? parseFloat(m[1]) : null;
  }
  var lowRate = pool.filter(function (n) { var r = rateOf(n); return r !== null && r < 1; });
  var highRate = pool.filter(function (n) { var r = rateOf(n); return r !== null && r >= 2; });
  if (lowRate.length > 0) {
    extraGroups.push(autoGroup("💰 低倍率自动", lowRate, 50));
    extraGroups.push({ name: "💰 低倍率", type: "select", proxies: ["💰 低倍率自动"].concat(lowRate) });
    extraSelectors.push("💰 低倍率");
  }
  if (highRate.length > 0) {
    extraGroups.push({ name: "💎 高倍率", type: "select", proxies: highRate.slice() });
    extraSelectors.push("💎 高倍率");
  }

  // 优选IP单独成组: 这类节点名字里没有地区词, 进不了地区组,
  // 单独拢成一组(自带自动测速), 方便在各分流组里一键选到这一整组。
  var prefNodes = pool.filter(function (n) { return /优选IP/i.test(n); });
  if (prefNodes.length > 0) {
    extraGroups.push(autoGroup("⭐ 优选IP自动", prefNodes, 50));
    extraGroups.push({ name: "⭐ 优选IP", type: "select", proxies: ["⭐ 优选IP自动"].concat(prefNodes) });
    extraSelectors.push("⭐ 优选IP");
  }

  // ---------- 主策略组 ----------
  var MAIN = "🚀 节点选择";
  var AUTO = "♻️ 自动选择";
  var FALLBACK = "🛡️ 故障转移";
  var LB = "⚖️ 负载均衡";
  var MANUAL = "👋 手动选择";
  var FINAL = "🐟 漏网之鱼";
  var mainOptions = [AUTO, FALLBACK, LB].concat(regionSelectors, extraSelectors, [MANUAL, "DIRECT"]);

  var groups = [];
  groups.push({ name: MAIN, type: "select", proxies: mainOptions.slice() });
  groups.push(autoGroup(AUTO, pool, 50));
  groups.push({
    name: FALLBACK, type: "fallback", proxies: pool,
    url: TEST_URL, interval: 600, lazy: true, timeout: 3000, "max-failed-times": 3
  });
  groups.push({
    name: LB, type: "load-balance", strategy: "consistent-hashing", proxies: pool,
    url: TEST_URL, interval: 600, lazy: true, timeout: 3000
  });
  groups.push({ name: MANUAL, type: "select", proxies: pool.slice() });

  // ---------- 精细分流组 ----------
  // 每组第一位 = 默认选择(v3.4 按全网主流推荐预置; 订阅里没有的地区自动跳过),
  // 其余选项照旧全保留, 用户随时可自己改选别的。
  function svcOptions(preferred) {
    var list = [];
    function push(x) { if (x && list.indexOf(x) < 0) list.push(x); }
    (preferred || []).forEach(function (p) {
      if (p === "DIRECT" || p === MAIN || p === AUTO || p === FALLBACK || p === MANUAL ||
          regionSelectors.indexOf(p) >= 0 || extraSelectors.indexOf(p) >= 0) push(p);
    });
    push(MAIN); push(AUTO); push(FALLBACK);
    regionSelectors.forEach(push);
    extraSelectors.forEach(push);
    push(MANUAL);
    return list;
  }
  var serviceGroups = [
    { name: "🤖 AI服务", proxies: svcOptions(["🇺🇸 美国"]) },
    { name: "📺 YouTube", proxies: svcOptions(["🇭🇰 香港", "🇯🇵 日本"]) },
    { name: "🔍 Google服务", proxies: svcOptions(["🇭🇰 香港"]) },
    { name: "🔔 FCM推送", proxies: svcOptions([FALLBACK]) },
    { name: "✈️ Telegram", proxies: svcOptions(["🇸🇬 新加坡"]) },
    { name: "🎬 流媒体", proxies: svcOptions(["🇸🇬 新加坡", "🇺🇸 美国"]) },
    { name: "🎮 游戏平台", proxies: svcOptions(["🇯🇵 日本"]) },
    { name: "🐙 GitHub", proxies: svcOptions([AUTO]) },
    { name: "📱 社交媒体", proxies: svcOptions(["🇸🇬 新加坡"]) },
    { name: "💰 支付平台", proxies: svcOptions(["🇺🇸 美国"]) },
    { name: "₿ 加密货币", proxies: svcOptions(["🇸🇬 新加坡"]) },
    { name: "⏩ 测速", proxies: svcOptions(["DIRECT"]) },
    { name: "📺 哔哩哔哩", proxies: svcOptions(["DIRECT"]) },
    { name: "🍎 苹果服务", proxies: svcOptions(["DIRECT"]) },
    { name: "Ⓜ️ 微软服务", proxies: svcOptions(["DIRECT"]) },
    { name: "🖥️ 远控工具", proxies: svcOptions(["DIRECT"]) }
  ];
  serviceGroups.forEach(function (s) {
    groups.push({ name: s.name, type: "select", proxies: s.proxies.slice() });
  });
  groups.push({ name: "🛑 广告拦截", type: "select", proxies: ["REJECT", "DIRECT"] });
  groups.push({ name: "🍃 应用净化", type: "select", proxies: ["REJECT", "DIRECT"] });
  groups.push({ name: FINAL, type: "select", proxies: mainOptions.slice() });

  // ---------- 保留链式代理依赖的原始分组 ----------
  // 有些订阅的家宽等节点是链式节点(dialer-proxy 先经前置组再出去),
  // 删掉被引用的前置组, 内核会报 "dialer-proxy not found" 并拒绝加载整个配置。
  var generatedNames = {};
  groups.concat(regionGroups, extraGroups).forEach(function (g) { generatedNames[g.name] = true; });
  var originalGroups = Array.isArray(config["proxy-groups"]) ? config["proxy-groups"] : [];
  var origByName = {};
  originalGroups.forEach(function (g) { if (g && g.name) origByName[g.name] = g; });
  var proxyByName = {};
  config.proxies.forEach(function (p) { if (p && p.name) proxyByName[p.name] = p; });
  var needed = {};
  config.proxies.forEach(function (p) { if (p && p["dialer-proxy"]) needed[p["dialer-proxy"]] = true; });
  var queue = Object.keys(needed);
  while (queue.length > 0) {
    var cur = queue.shift();
    var og = origByName[cur];
    if (og && Array.isArray(og.proxies)) {
      og.proxies.forEach(function (m) {
        if (origByName[m] && !needed[m]) { needed[m] = true; queue.push(m); }
      });
    }
  }
  var preserved = [];
  Object.keys(needed).forEach(function (n) {
    if (generatedNames[n] || proxyByName[n]) return;
    if (origByName[n]) { preserved.push(origByName[n]); return; }
    // 原配置里也没有这个组: 兜底新建, 成员为所有非链式节点, 保证链不断
    var front = pool.filter(function (x) { var px = proxyByName[x]; return !(px && px["dialer-proxy"]); });
    preserved.push({ name: n, type: "select", proxies: front.length > 0 ? front : ["DIRECT"] });
  });
  groups = groups.concat(regionGroups, extraGroups, preserved);
  config["proxy-groups"] = groups;

  // ---------- 去广告规则集(ACL4SSR, 每日自动更新, UnBan 先行防误杀) ----------
  function adProvider(url, file) {
    return { type: "http", behavior: "classical", format: "text", interval: 86400, url: url, path: "./ruleset/" + file };
  }
  config["rule-providers"] = {
    UnBan: adProvider("https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/UnBan.list", "UnBan.list"),
    BanAD: adProvider("https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/BanAD.list", "BanAD.list"),
    BanProgramAD: adProvider("https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/BanProgramAD.list", "BanProgramAD.list"),
    BanEasyList: adProvider("https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/BanEasyList.list", "BanEasyList.list")
  };

  // ---------- 分流规则(顺序即优先级) ----------
  config.rules = [
    // 防误杀白名单最先
    "RULE-SET,UnBan,DIRECT",
    // 去广告四层: 程序广告(APP开屏/内嵌) + 广告域名 + EasyList + 内置广告分类
    "RULE-SET,BanProgramAD,🍃 应用净化",
    "RULE-SET,BanAD,🛑 广告拦截",
    "RULE-SET,BanEasyList,🛑 广告拦截",
    "GEOSITE,category-ads-all,🛑 广告拦截",
    // 局域网/私有直连
    "GEOIP,private,DIRECT,no-resolve",
    "GEOSITE,private,DIRECT",
    // AI
    "DOMAIN-SUFFIX,openai.com,🤖 AI服务",
    "DOMAIN-SUFFIX,chatgpt.com,🤖 AI服务",
    "DOMAIN-SUFFIX,oaistatic.com,🤖 AI服务",
    "DOMAIN-SUFFIX,anthropic.com,🤖 AI服务",
    "DOMAIN-SUFFIX,claude.ai,🤖 AI服务",
    "DOMAIN-SUFFIX,perplexity.ai,🤖 AI服务",
    "DOMAIN-SUFFIX,x.ai,🤖 AI服务",
    "DOMAIN-SUFFIX,grok.com,🤖 AI服务",
    "DOMAIN-SUFFIX,poe.com,🤖 AI服务",
    "DOMAIN-SUFFIX,deepseek.com,🤖 AI服务",
    "GEOSITE,openai,🤖 AI服务",
    "GEOSITE,category-ai-!cn,🤖 AI服务",
    // 常用国外服务
    "GEOSITE,youtube,📺 YouTube",
    "DOMAIN,mtalk.google.com,🔔 FCM推送",
    "DOMAIN-SUFFIX,fcm.googleapis.com,🔔 FCM推送",
    "GEOSITE,google,🔍 Google服务",
    "GEOSITE,telegram,✈️ Telegram",
    "GEOIP,telegram,✈️ Telegram,no-resolve",
    "GEOSITE,netflix,🎬 流媒体",
    "GEOSITE,disney,🎬 流媒体",
    "GEOSITE,hbo,🎬 流媒体",
    "GEOSITE,spotify,🎬 流媒体",
    "DOMAIN-KEYWORD,emby,🎬 流媒体",
    "GEOSITE,github,🐙 GitHub",
    "DOMAIN-SUFFIX,steamcontent.com,DIRECT",
    "DOMAIN-SUFFIX,steamstatic.com,DIRECT",
    "GEOSITE,steam,🎮 游戏平台",
    "GEOSITE,twitter,📱 社交媒体",
    "GEOSITE,facebook,📱 社交媒体",
    "GEOSITE,instagram,📱 社交媒体",
    "GEOSITE,tiktok,📱 社交媒体",
    "GEOSITE,paypal,💰 支付平台",
    "GEOSITE,category-cryptocurrency,₿ 加密货币",
    "DOMAIN-SUFFIX,speedtest.net,⏩ 测速",
    "DOMAIN-SUFFIX,ookla.com,⏩ 测速",
    "DOMAIN-KEYWORD,speedtest,⏩ 测速",
    // 国内服务(默认直连, 组里可改)
    "GEOSITE,bilibili,📺 哔哩哔哩",
    "GEOSITE,apple,🍎 苹果服务",
    "GEOSITE,microsoft,Ⓜ️ 微软服务",
    "DOMAIN-SUFFIX,teamviewer.com,🖥️ 远控工具",
    "DOMAIN-SUFFIX,anydesk.com,🖥️ 远控工具",
    "DOMAIN-SUFFIX,todesk.com,🖥️ 远控工具",
    // 国内外分流兜底
    "GEOSITE,cn,DIRECT",
    "GEOIP,CN,DIRECT",
    "GEOSITE,geolocation-!cn,🚀 节点选择",
    "MATCH,🐟 漏网之鱼"
  ];

  // ---------- 网速/连接优化 ----------
  config["tcp-concurrent"] = true;
  config["unified-delay"] = true;
  config["global-client-fingerprint"] = "chrome";
  config.profile = { "store-selected": true, "store-fake-ip": true };
  config.sniffer = {
    enable: true,
    "force-dns-mapping": true,
    "parse-pure-ip": true,
    "override-destination": false,
    sniff: {
      HTTP: { ports: [80, "8080-8880"] },
      TLS: { ports: [443, 8443] },
      QUIC: { ports: [443, 8443] }
    }
  };

  // ---------- DNS: 国内/国外分开解析防污染, fake-ip 兼容名单 ----------
  config.dns = {
    enable: true,
    ipv6: false,
    "enhanced-mode": "fake-ip",
    "fake-ip-range": "198.18.0.1/16",
    "fake-ip-filter": [
      "*.lan", "*.local", "localhost", "localhost.ptlogin2.qq.com",
      "time.*.com", "time.*.gov", "ntp.*.com", "ntp.*.org",
      "+.stun.*.*", "+.stun.*.*.*", "stun.*.*", "stun.*.*.*",
      "*.battlenet.com", "*.blizzard.com",
      "*.srv.nintendo.net", "*.stun.playstation.net", "+.sonyentertainmentnetwork.com",
      "*.xboxlive.com",
      "*.msftconnecttest.com", "*.msftncsi.com",
      "*.music.163.com", "*.126.net"
    ],
    "use-hosts": true,
    "respect-rules": true,
    "default-nameserver": ["223.5.5.5", "119.29.29.29"],
    nameserver: ["https://dns.alidns.com/dns-query", "https://doh.pub/dns-query"],
    "proxy-server-nameserver": ["https://dns.alidns.com/dns-query", "https://doh.pub/dns-query"],
    "nameserver-policy": {
      "geosite:cn,private": ["https://dns.alidns.com/dns-query", "https://doh.pub/dns-query"],
      "geosite:geolocation-!cn": ["https://dns.cloudflare.com/dns-query", "https://dns.google/dns-query"]
    }
  };

  return config;
}
