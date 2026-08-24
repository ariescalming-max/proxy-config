/**
 * ============================================================================
 * Clash Verge Rev / mihomo —— 全局扩展脚本 (Global Extended Script)
 * 位置: 订阅 → 全局扩展脚本(Script)   作用范围: 所有订阅
 *
 * 设计要点
 *  1) 一份脚本适配多机场: 地区分组按订阅里"真实存在的节点"动态生成,
 *     没有对应节点的地区不会留下空分组 (mihomo 遇到空分组会直接报错)
 *  2) 机场自带的分组/规则整体替换; 但 merge/覆写链里注入的 DIRECT/REJECT
 *     规则会被自动保留 (你的 CF/WeGame/Trae 直连规则不会丢)
 *  3) 规则集统一用 MetaCubeX .mrs 二进制格式, 体积小、加载快, 走 jsDelivr CDN
 *  4) 分组名沿用旧脚本命名, store-selected 里已保存的选择不会失效
 *  5) 机场公告节点(剩余流量/到期时间)不参与任何自动分组和测速
 *  6) 出现意外时返回原配置而不是 throw, 不会把订阅变成不可用状态
 * ============================================================================
 */

/* ------------------------------ 1. 可调开关 ------------------------------ */
const OPT = {
  udpForAll: true,          // 给支持 UDP 的协议统一开 UDP
  regionGroups: true,       // 生成地区分组 (按真实节点动态生成)
  residentialGroup: true,   // 生成「🏠 家宽原生」: AI/流媒体解锁更稳
  japanGroup: true,         // 生成「🗾 日本服务」: go.jp/ac.jp/JLPT 走日本节点
  scholarGroup: true,       // 生成「📚 学术资源」: 谷歌学术/期刊
  keepUserRules: true,      // 保留链里已有的 DIRECT/REJECT 规则
  rulesetProxy: "",         // 规则集下载走哪个分组, 留空 = 直连下载
  // 明文代理(http/socks5 不带 TLS): 本机到节点这一段是明文, 你访问的域名对
  // 本地网络/运营商可见, 代理账号密码也是明文传输。所以不让它们参与"按延迟
  // 自动挑选"的分组; 仍可在 ⚙️ 节点选择 等分组里手动选中。留空字符串=不排除
  excludePlaintextTypes: "http|socks5",
  plaintextInHome: true,    // 「🏠 家宽原生」是否仍保留明文家宽节点(解锁用)
  cdn: "https://testingcf.jsdelivr.net",
  fallback: "🔰 模式选择",  // 规则目标不存在时回退到这个分组
  testUrl: "https://www.gstatic.com/generate_204",
  testInterval: 120,        // 自动测速/健康检查间隔(秒), 0 = 不自动测
};

/* 落地节点 / 链式代理: 不用就保持空数组。填了才会出现「🕊️ 落地节点」分组 */
const LANDING_NODES = [
  // {
  //   name: "🏠 落地-Webshare", type: "socks5",
  //   server: "1.2.3.4", port: 12345,
  //   username: "", password: "",
  //   udp: true, "skip-cert-verify": true,
  //   "dialer-proxy": "⚙️ 节点选择",   // 先出机场节点, 再落地
  // },
];

/* --------------------------- 2. 节点名匹配规则 --------------------------- */
// 注意: 下面的正则同时交给 mihomo(Go RE2) 使用, 不能用 (?=) (?!) (?<=) 等断言
// 机场的信息/公告节点: 不进任何自动分组
// 注意别写太宽的词(比如单独的"流量"), 否则「XX流量站-线路1」这种真节点会被误杀
const INFO_PATTERN =
  "剩余|到期|过期|重置|官网|客服|通知|失联|发布页|网址|导航|订阅|续费|试用|" +
  "邀请|加群|群组|禁止|expire|reset|renew|website|sponsor|invite";

// 家宽/原生 IP: ChatGPT、Claude、流媒体解锁成功率最高的一类节点
const RESIDENTIAL_PATTERN =
  "家宽|家庭宽带|原生|住宅|\\bISP\\b|\\bHome\\b|Residential|Broadband|native";

// AI 服务不能用的落地: 港澳/大陆/俄罗斯/伊朗 会被直接拒绝或风控
// 这里故意不写 \bCN[0-9]*\b —— 否则"CN2 GIA"这种优质线路会被误伤
const AI_EXCLUDE_PATTERN =
  "🇭🇰|香港|\\bHK[0-9]*\\b|\\bHKG\\b|\\bHKT\\b|Hong ?Kong|澳门|澳門|Macao|\\bMO\\b|" +
  "中国|回国|China|\\bCN\\b|俄罗斯|俄羅斯|Russia|\\bRU[0-9]*\\b|伊朗|Iran";

// 地区分组定义: 有节点才建组
// 代码写成 \bHK[0-9]*\b 是为了兼容 HK / HK01 这类写法; HKT/HKG 之类另列
const REGIONS = [
  {
    name: "🇭🇰 香港", icon: "HK",
    pattern: "🇭🇰|香港|港區|港区|深港|沪港|台港|\\bHK[0-9]*\\b|\\bHKG\\b|" +
             "\\bHKT\\b|\\bHKBN\\b|Hong ?Kong",
  },
  {
    name: "🇹🇼 台湾", icon: "TW",
    pattern: "🇹🇼|台湾|台灣|臺灣|台北|台中|新北|彰化|\\bTW[0-9]*\\b|\\bTWN\\b|" +
             "Taiwan|Taipei|Hinet",
  },
  {
    name: "🇯🇵 日本", icon: "JP",
    pattern: "🇯🇵|日本|东京|東京|大阪|埼玉|名古屋|沪日|川日|泉日|深日|" +
             "\\bJP[0-9]*\\b|\\bJPN\\b|Japan|Tokyo|Osaka",
  },
  {
    name: "🇸🇬 新加坡", icon: "SG",
    pattern: "🇸🇬|新加坡|狮城|獅城|\\bSG[0-9]*\\b|\\bSGP\\b|Singapore",
  },
  {
    name: "🇰🇷 韩国", icon: "KR",
    pattern: "🇰🇷|韩国|韓國|首尔|首爾|\\bKR[0-9]*\\b|\\bKOR\\b|Korea|Seoul",
  },
  {
    name: "🇺🇸 美国", icon: "US",
    pattern: "🇺🇸|美国|美國|洛杉矶|圣何塞|西雅图|芝加哥|纽约|达拉斯|凤凰城|" +
             "弗吉尼亚|阿什本|硅谷|\\bUS[0-9]*\\b|\\bUSA\\b|United ?States|America|" +
             "Los ?Angeles|San ?Jose|Seattle|Chicago|New ?York|Dallas|Ashburn",
  },
  {
    name: "🇪🇺 欧洲", icon: "EU",
    pattern: "🇩🇪|🇬🇧|🇳🇱|🇫🇷|🇷🇺|🇸🇪|🇨🇭|🇮🇹|🇪🇸|🇵🇱|🇫🇮|🇹🇷|" +
             "德国|德國|英国|英國|法国|法國|荷兰|荷蘭|瑞士|瑞典|意大利|西班牙|" +
             "波兰|芬兰|挪威|丹麦|爱尔兰|奥地利|比利时|捷克|土耳其|俄罗斯|乌克兰|" +
             "伦敦|法兰克福|阿姆斯特丹|巴黎|\\bDE[0-9]*\\b|\\bGER\\b|\\bUK[0-9]*\\b|" +
             "\\bGB[0-9]*\\b|\\bNL[0-9]*\\b|\\bFR[0-9]*\\b|\\bRU[0-9]*\\b|" +
             "\\bSE[0-9]*\\b|\\bCH[0-9]*\\b|\\bIT[0-9]*\\b|\\bES[0-9]*\\b|" +
             "\\bPL[0-9]*\\b|\\bFI[0-9]*\\b|\\bTR[0-9]*\\b|" +
             "Germany|England|Britain|France|Netherlands|Russia|" +
             "Sweden|Switzerland|Italy|Spain|Poland|Finland|Turkey|London|" +
             "Frankfurt|Amsterdam|Paris",
  },
];
const OTHER_REGION = { name: "🌐 其他地区", icon: "Global" };

/* ------------------------------- 3. DNS ---------------------------------- */
const DNS_CN = [
  "https://223.5.5.5/dns-query",   // 阿里 DoH
  "https://doh.pub/dns-query",     // 腾讯 DoH
];
const DNS_FOREIGN = [
  "https://1.1.1.1/dns-query",     // Cloudflare
  "https://8.8.8.8/dns-query",     // Google
  "https://9.9.9.9/dns-query",     // Quad9
];

const DNS_CONFIG = {
  enable: true,
  listen: "127.0.0.1:1053",        // 只监听本机, 不对局域网暴露 DNS
  ipv6: false,
  "prefer-h3": false,
  "respect-rules": true,           // 国外域名的 DNS 也走代理出去, 防污染/防泄露
  "use-system-hosts": false,
  "cache-algorithm": "arc",
  "enhanced-mode": "fake-ip",
  "fake-ip-range": "198.18.0.1/16",
  "fake-ip-filter-mode": "blacklist",
  "fake-ip-filter": [
    "+.lan", "+.local", "+.localdomain", "+.home.arpa",
    // Windows 网络图标/连通性检测
    "+.msftconnecttest.com", "+.msftncsi.com",
    // QQ / 微信 快速登录检测
    "localhost.ptlogin2.qq.com", "localhost.sec.qq.com",
    "localhost.work.weixin.qq.com",
    // STUN / NTP / 游戏联机
    "stun.*", "+.stun.*.*", "time.*.com", "ntp.*.com", "+.ntp.org.cn",
    "+.srv.nintendo.net", "+.stun.playstation.net", "*.xboxlive.com",
    // 国内 CDN / 直播回源
    "*.mcdn.bilivideo.cn", "+.market.xiaomi.com",
  ],
  "default-nameserver": ["223.5.5.5", "119.29.29.29"],
  nameserver: DNS_FOREIGN,
  "proxy-server-nameserver": DNS_CN,   // 解析机场域名用国内 DNS, 避免死循环
  "direct-nameserver": DNS_CN,         // 直连流量用国内 DNS, 保证 CDN 就近
  "direct-nameserver-follow-policy": false,
  "nameserver-policy": {
    "geosite:cn,private": DNS_CN,
    "+.lan,+.local": DNS_CN,
  },
};

/* ------------------------- 4. 域名嗅探 / 通用参数 ------------------------- */
// fake-ip 模式下, 嗅探能把"只有 IP 的连接"还原成域名, 让分流规则命中率更高
const SNIFFER_CONFIG = {
  enable: true,
  "force-dns-mapping": true,
  "parse-pure-ip": true,
  "override-destination": false,
  sniff: {
    HTTP: { ports: [80, "8080-8880"], "override-destination": true },
    TLS: { ports: [443, 8443] },
    QUIC: { ports: [443, 8443] },
  },
  "skip-domain": [
    "+.apple.com", "+.push.apple.com",
    "+.qq.com", "+.wechat.com", "+.weixin.qq.com",
    "Mijia Cloud", "dlg.io.mi.com",
    "+.oray.com", "+.sunlogin.net",
  ],
};

// 这些是"脚本层"参数; 端口/局域网/TUN/系统代理仍由 Clash Verge 界面控制
// 注: global-client-fingerprint 在 mihomo 1.19+ 已被移除, 不要再写进来
const GENERAL_CONFIG = {
  "unified-delay": true,        // 统一延迟: 去掉握手耗时, 测速更接近真实
  "tcp-concurrent": true,       // 域名多 IP 并发握手, 首屏更快
  "find-process-mode": "strict",// PROCESS-NAME 规则需要它
  "keep-alive-interval": 30,
  "geo-auto-update": true,
  "geo-update-interval": 24,
  profile: { "store-selected": true, "store-fake-ip": true },
};

/* ------------------------------ 5. 规则集 -------------------------------- */
const RP_BASE = { type: "http", interval: 86400 };
if (OPT.rulesetProxy) RP_BASE.proxy = OPT.rulesetProxy;

function geosite(key, file) {
  const f = file || key;
  return Object.assign({}, RP_BASE, {
    behavior: "domain", format: "mrs",
    url: OPT.cdn + "/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/" + f + ".mrs",
    path: "./ruleset/mihomo/site-" + key + ".mrs",
  });
}
function geoip(key, file) {
  const f = file || key;
  return Object.assign({}, RP_BASE, {
    behavior: "ipcidr", format: "mrs",
    url: OPT.cdn + "/gh/MetaCubeX/meta-rules-dat@meta/geo/geoip/" + f + ".mrs",
    path: "./ruleset/mihomo/ip-" + key + ".mrs",
  });
}

const RULE_PROVIDERS = {
  // 基础
  private: geosite("private"),
  "private-ip": geoip("private-ip", "private"),
  ads: geosite("ads", "category-ads-all"),
  // AI
  openai: geosite("openai"),
  anthropic: geosite("anthropic"),
  gemini: geosite("gemini", "google-gemini"),
  xai: geosite("xai"),
  perplexity: geosite("perplexity"),
  // 应用
  telegram: geosite("telegram"),
  "telegram-ip": geoip("telegram-ip", "telegram"),
  youtube: geosite("youtube"),
  netflix: geosite("netflix"),
  disney: geosite("disney"),
  spotify: geosite("spotify"),
  tiktok: geosite("tiktok"),
  google: geosite("google"),
  github: geosite("github"),
  microsoft: geosite("microsoft"),
  onedrive: geosite("onedrive"),
  apple: geosite("apple"),
  pikpak: geosite("pikpak"),
  bybit: geosite("bybit"),
  steam: geosite("steam"),
  games: geosite("games", "category-games"),
  scholar: geosite("scholar", "category-scholar-!cn"),
  // 国内 / 国外
  bilibili: geosite("bilibili"),
  cn: geosite("cn"),
  "cn-ip": geoip("cn-ip", "cn"),
  foreign: geosite("foreign", "geolocation-!cn"),
};

/* ------------------------------ 6. 分组名 -------------------------------- */
const G = {
  mode: "🔰 模式选择",
  pick: "⚙️ 节点选择",
  urltest: "♻️ 延迟选优",
  fallback: "🚑 故障转移",
  lbHash: "⚖️ 负载均衡(散列)",
  lbRR: "☁️ 负载均衡(轮询)",
  home: "🏠 家宽原生",
  landing: "🕊️ 落地节点",
  ai: "💸 ChatGPT-Gemini-XAI-Perplexity",
  claude: "💵 Claude",
  telegram: "📲 电报消息",
  google: "📢 谷歌服务",
  apple: "🍎 苹果服务",
  microsoft: "Ⓜ️ 微软服务",
  youtube: "📹 油管视频",
  media: "🌍 国外媒体",
  pikpak: "🅿️ PikPak",
  bybit: "🪙 Bybit",
  japan: "🗾 日本服务",
  game: "🎮 游戏平台",
  scholar: "📚 学术资源",
  ads: "🥰 广告过滤",
  direct: "🔗 全局直连",
  block: "❌ 全局拦截",
  myDirect: "🐬 自定义直连",
  myProxy: "🐳 自定义代理",
  final: "🐟 漏网之鱼",
};

/* ------------------------------ 7. 规则 ---------------------------------- */
// 走直连的进程: 腾讯游戏/反作弊(挂代理会踢号)、Steam 客户端、本地 IDE
const DIRECT_PROCESS = [
  "crossfire.exe", "crossfire_x64.exe", "launchcrossfire.exe", "GameLoader.exe",
  "ACE-Helper.exe", "ACE-Service64.exe", "SGuard64.exe", "SGuardSvc64.exe",
  "TenSafe.exe", "TP3Helper.exe", "WeGame.exe", "wegame.exe",
  "steam.exe", "steamwebhelper.exe",
  "Trae.exe", "Trae CN.exe", "trae.exe", "trae-cn.exe",
];
// 走直连的域名: 自考报名/腾讯游戏相关/自建服务
const DIRECT_DOMAIN = [
  "hybgzs.com", "cf.qq.com", "gamesafe.qq.com", "anticheatexpert.com",
  "wegame.com.cn", "gtimg.cn", "gtimg.com", "tencent.com", "qzz.io",
];
// 强制走代理的域名
const PROXY_DOMAIN = [
  "immersivetranslate.com", "githubusercontent.com", "cursor.sh",
];
// 走日本节点的域名 (go.jp=省厅/入管, ac.jp=大学, or.jp=JEES/NHK 等法人)
const JAPAN_DOMAIN = [
  "go.jp", "ac.jp", "or.jp", "ne.jp", "lg.jp",
  "jlpt.jp", "jpss.jp", "weblio.jp", "nicovideo.jp", "yahoo.co.jp",
];

function buildRules() {
  const R = [];
  // 1) 自定义: 放最前面, 优先级最高
  for (let i = 0; i < DIRECT_PROCESS.length; i++)
    R.push("PROCESS-NAME," + DIRECT_PROCESS[i] + "," + G.myDirect);
  for (let i = 0; i < DIRECT_DOMAIN.length; i++)
    R.push("DOMAIN-SUFFIX," + DIRECT_DOMAIN[i] + "," + G.myDirect);
  for (let i = 0; i < PROXY_DOMAIN.length; i++)
    R.push("DOMAIN-SUFFIX," + PROXY_DOMAIN[i] + "," + G.myProxy);

  // 2) 局域网 / 私有地址
  R.push("RULE-SET,private," + G.direct);
  R.push("RULE-SET,private-ip," + G.direct + ",no-resolve");
  R.push("IP-CIDR,198.18.0.0/16," + G.block + ",no-resolve"); // fake-ip 段兜底

  // 3) 广告
  R.push("RULE-SET,ads," + G.ads);

  // 4) AI (放在 google/microsoft 前面, 否则 gemini/copilot 会被抢走)
  R.push("RULE-SET,anthropic," + G.claude);
  R.push("RULE-SET,openai," + G.ai);
  R.push("RULE-SET,gemini," + G.ai);
  R.push("RULE-SET,xai," + G.ai);
  R.push("RULE-SET,perplexity," + G.ai);

  // 5) 应用分流
  R.push("RULE-SET,telegram," + G.telegram);
  R.push("RULE-SET,telegram-ip," + G.telegram + ",no-resolve");
  R.push("RULE-SET,youtube," + G.youtube);
  R.push("RULE-SET,netflix," + G.media);
  R.push("RULE-SET,disney," + G.media);
  R.push("RULE-SET,spotify," + G.media);
  R.push("RULE-SET,tiktok," + G.media);
  R.push("RULE-SET,pikpak," + G.pikpak);
  R.push("RULE-SET,bybit," + G.bybit);
  R.push("RULE-SET,github," + G.mode);
  R.push("RULE-SET,scholar," + G.scholar);
  R.push("RULE-SET,google," + G.google);
  R.push("RULE-SET,onedrive," + G.microsoft);
  R.push("RULE-SET,microsoft," + G.microsoft);
  R.push("RULE-SET,apple," + G.apple);
  R.push("RULE-SET,steam," + G.game);
  R.push("RULE-SET,games," + G.game);

  // 6) 日本站点 (赴日备考: 入管/文科省/JASSO/大学官网/JLPT)
  for (let i = 0; i < JAPAN_DOMAIN.length; i++)
    R.push("DOMAIN-SUFFIX," + JAPAN_DOMAIN[i] + "," + G.japan);

  // 7) 国内直连
  R.push("RULE-SET,bilibili," + G.direct);
  R.push("RULE-SET,cn," + G.direct);
  R.push("RULE-SET,cn-ip," + G.direct + ",no-resolve");
  R.push("GEOIP,CN," + G.direct + ",no-resolve");

  // 8) 兜底
  R.push("RULE-SET,foreign," + G.mode);
  R.push("MATCH," + G.final);
  return R;
}

/* ------------------------------ 8. 分组 ---------------------------------- */
function qure(n) {
  return OPT.cdn + "/gh/Koolson/Qure@master/IconSet/Color/" + n + ".png";
}
function vicon(n) {
  return OPT.cdn + "/gh/clash-verge-rev/clash-verge-rev.github.io@main" +
         "/docs/assets/icons/" + n + ".svg";
}

const GROUP_BASE = {
  url: OPT.testUrl,
  interval: OPT.testInterval,
  timeout: 3000,
  "max-failed-times": 3,
  lazy: true,
  hidden: false,
};
function grp(o) {
  return Object.assign({}, GROUP_BASE, o);
}
// 纯按延迟自动挑节点的分组: 额外排除明文代理类型
function autoGrp(o) {
  const g = Object.assign({}, GROUP_BASE, o);
  if (OPT.excludePlaintextTypes) g["exclude-type"] = OPT.excludePlaintextTypes;
  return g;
}

// 所有可能的地区分组名; 不存在的会在收尾阶段被自动摘掉
const ALL_REGION_NAMES = REGIONS.map(function (r) { return r.name; })
  .concat([OTHER_REGION.name]);

function buildGroups() {
  const AUTO = [G.urltest, G.fallback, G.lbHash, G.lbRR];
  // 手动挑选类候选: 分组 + 地区 + 落地
  const PICKS = [G.pick, G.home].concat(ALL_REGION_NAMES, AUTO, [G.landing]);
  // 应用分流类候选: 先"跟随模式选择", 再给手动项
  const APP = [G.mode].concat(PICKS, [G.direct]);
  const groups = [];

  // —— 总控 ——
  groups.push(grp({
    name: G.mode, type: "select",
    proxies: PICKS.concat([G.direct]),
    icon: qure("Rocket"),
  }));
  groups.push(grp({
    name: G.pick, type: "select",
    proxies: AUTO.slice(), "include-all": true,
    icon: vicon("adjust"),
  }));
  groups.push(autoGrp({
    name: G.urltest, type: "url-test", tolerance: 50,
    "include-all": true, icon: qure("Auto"),
  }));
  groups.push(autoGrp({
    name: G.fallback, type: "fallback",
    "include-all": true, icon: vicon("ambulance"),
  }));
  groups.push(autoGrp({
    name: G.lbHash, type: "load-balance", strategy: "consistent-hashing",
    "include-all": true, icon: vicon("merry_go"),
  }));
  groups.push(autoGrp({
    name: G.lbRR, type: "load-balance", strategy: "round-robin",
    "include-all": true, icon: vicon("balance"),
  }));

  // —— 家宽/原生 IP ——
  // 用 fallback 而不是 url-test: 只要当前节点还活着就一直用它, IP 稳定,
  // AI 站点不容易要求重新登录; 节点挂了才自动切到下一个可用的
  // 这个组默认保留明文 http 家宽节点(它们往往是解锁效果最好的一批),
  // 想连这里也只用加密节点, 把 OPT.plaintextInHome 改成 false
  if (OPT.residentialGroup) {
    groups.push((OPT.plaintextInHome ? grp : autoGrp)({
      name: G.home, type: "fallback",
      "include-all": true, filter: "(?i)" + RESIDENTIAL_PATTERN,
      icon: qure("Available"),
    }));
  }

  // —— 落地节点 ——
  if (LANDING_NODES.length) {
    groups.push(grp({
      name: G.landing, type: "select",
      proxies: LANDING_NODES.map(function (p) { return p.name; }),
      icon: vicon("openwrt"),
    }));
  }

  // —— 地区分组 (url-test 自动挑该地区最快的) ——
  if (OPT.regionGroups) {
    for (let i = 0; i < REGIONS.length; i++) {
      groups.push(autoGrp({
        name: REGIONS[i].name, type: "url-test", tolerance: 50,
        "include-all": true, filter: "(?i)" + REGIONS[i].pattern,
        icon: qure(REGIONS[i].icon),
      }));
    }
    groups.push(autoGrp({
      name: OTHER_REGION.name, type: "url-test", tolerance: 50,
      "include-all": true,
      "exclude-filter": "(?i)" + REGIONS.map(function (r) {
        return r.pattern;
      }).join("|"),
      icon: qure(OTHER_REGION.icon),
    }));
  }

  // —— AI: 优先家宽原生, 排除港澳/大陆/俄伊 ——
  const AI_PICKS = [G.home, "🇯🇵 日本", "🇺🇸 美国", "🇸🇬 新加坡", "🇹🇼 台湾",
                    "🇪🇺 欧洲", G.mode, G.pick, G.urltest, G.direct];
  groups.push(grp({
    name: G.claude, type: "select", proxies: AI_PICKS.slice(),
    "include-all": true, "exclude-filter": "(?i)" + AI_EXCLUDE_PATTERN,
    icon: vicon("claude"),
  }));
  groups.push(grp({
    name: G.ai, type: "select", proxies: AI_PICKS.slice(),
    "include-all": true, "exclude-filter": "(?i)" + AI_EXCLUDE_PATTERN,
    icon: vicon("chatgpt"),
  }));

  // —— 应用分流 ——
  groups.push(grp({
    name: G.telegram, type: "select", proxies: APP.slice(),
    "include-all": true, icon: qure("Telegram"),
  }));
  groups.push(grp({
    name: G.youtube, type: "select", proxies: APP.slice(),
    "include-all": true, icon: qure("YouTube"),
  }));
  groups.push(grp({
    name: G.media, type: "select", proxies: APP.slice(),
    "include-all": true, icon: qure("Streaming"),
  }));
  groups.push(grp({
    name: G.google, type: "select", proxies: APP.slice(),
    "include-all": true, icon: qure("Google"),
  }));
  groups.push(grp({
    name: G.pikpak, type: "select", proxies: APP.slice(),
    "include-all": true, icon: qure("Download"),
  }));
  groups.push(grp({
    name: G.bybit, type: "select", proxies: APP.slice(),
    "include-all": true, icon: qure("Cryptocurrency"),
  }));
  if (OPT.scholarGroup) {
    groups.push(grp({
      name: G.scholar, type: "select", proxies: APP.slice(),
      "include-all": true, icon: qure("Scholar"),
    }));
  }
  if (OPT.japanGroup) {
    groups.push(grp({
      name: G.japan, type: "select",
      proxies: ["🇯🇵 日本", G.home, G.mode, G.pick, G.direct],
      "include-all": true, icon: qure("Japan"),
    }));
  }

  // —— 默认直连更合适的: 苹果 / 微软 / 游戏 ——
  const DIRECT_FIRST = [G.direct, G.mode].concat(PICKS);
  groups.push(grp({
    name: G.apple, type: "select", proxies: DIRECT_FIRST.slice(),
    "include-all": true, icon: qure("Apple"),
  }));
  groups.push(grp({
    name: G.microsoft, type: "select", proxies: DIRECT_FIRST.slice(),
    "include-all": true, icon: qure("Microsoft"),
  }));
  groups.push(grp({
    name: G.game, type: "select", proxies: DIRECT_FIRST.slice(),
    "include-all": true, icon: qure("Game"),
  }));

  // —— 直连 / 拦截 / 自定义 / 兜底 ——
  groups.push(grp({
    name: G.ads, type: "select", proxies: ["REJECT", "DIRECT", G.mode],
    icon: qure("Advertising"),
  }));
  groups.push(grp({
    name: G.direct, type: "select", proxies: ["DIRECT", G.pick, G.urltest],
    "include-all": true, icon: qure("Direct"),
  }));
  groups.push(grp({
    name: G.block, type: "select", proxies: ["REJECT", "REJECT-DROP", "DIRECT"],
    icon: qure("Reject"),
  }));
  groups.push(grp({
    name: G.myDirect, type: "select",
    proxies: ["DIRECT", G.mode].concat(PICKS),
    "include-all": true, icon: qure("Bypass"),
  }));
  groups.push(grp({
    name: G.myProxy, type: "select", proxies: APP.slice(),
    "include-all": true, icon: qure("Proxy"),
  }));
  groups.push(grp({
    name: G.final, type: "select", proxies: APP.slice(),
    "include-all": true, icon: qure("Final"),
  }));
  return orderGroups(groups);
}

// 界面显示顺序: 只影响 Verge 里分组卡片的排列, 跟分流逻辑完全无关。
// 前面放天天要点的(总控 + 应用分流), 后面放设一次就不动的(地区/自动/兜底)
function orderGroups(groups) {
  const order = [
    G.mode, G.pick,
    G.claude, G.ai, G.telegram, G.youtube, G.media, G.google,
    G.japan, G.scholar, G.pikpak, G.bybit, G.apple, G.microsoft, G.game,
    G.home,
  ].concat(ALL_REGION_NAMES).concat([
    G.urltest, G.fallback, G.lbHash, G.lbRR, G.landing,
    G.myDirect, G.myProxy, G.ads, G.direct, G.block, G.final,
  ]);
  const out = [];
  const used = {};
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < groups.length; j++) {
      if (!used[j] && groups[j].name === order[i]) { out.push(groups[j]); used[j] = 1; }
    }
  }
  for (let j = 0; j < groups.length; j++) if (!used[j]) out.push(groups[j]);
  return out;
}

/* ----------------------------- 9. 工具函数 ------------------------------- */
const BUILTIN = ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE", "GLOBAL"];
const KEEPABLE = ["DIRECT", "REJECT", "REJECT-DROP", "PASS"];
const UDP_TYPES = ["ss", "ssr", "vmess", "vless", "trojan", "snell", "socks5",
  "hysteria", "hysteria2", "tuic", "wireguard", "anytls", "mieru"];
const RULE_PARAMS = ["no-resolve", "src"];

function say(msg) {
  try { console.log("[global-script] " + msg); } catch (e) { /* ignore */ }
}
function re(p) { return new RegExp(p, "i"); }
function bare(p) { return String(p).replace("(?i)", ""); }
function has(obj, k) { return Object.prototype.hasOwnProperty.call(obj, k); }

// 规则里"策略"所在的位置: TYPE,VALUE,POLICY[,no-resolve]
function targetIndex(parts) {
  let i = parts.length - 1;
  while (i > 0 && RULE_PARAMS.indexOf(parts[i].trim().toLowerCase()) !== -1) i--;
  return i;
}

// 节点规范化: 丢弃残缺节点、处理重名、按协议开 UDP
function normalizeProxies(list) {
  const out = [];
  const seen = {};
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || typeof p !== "object" || typeof p.name !== "string" || !p.name) {
      say("跳过一个无名/残缺节点");
      continue;
    }
    let name = p.name;
    if (has(seen, name)) {
      seen[name] += 1;
      const nn = name + " #" + seen[name];
      say("重名节点改名: " + name + " -> " + nn);
      name = nn;
    }
    seen[name] = 1;
    p.name = name;
    if (OPT.udpForAll && UDP_TYPES.indexOf(String(p.type || "").toLowerCase()) !== -1) {
      p.udp = true;
    }
    out.push(p);
  }
  return out;
}

// 落地节点校验: server/port 没填的直接忽略, 免得整份配置报错
function validLandingNodes() {
  const out = [];
  for (let i = 0; i < LANDING_NODES.length; i++) {
    const p = LANDING_NODES[i];
    if (!p || !p.name || !p.server || !p.port) {
      if (p && p.name) say("落地节点 " + p.name + " 缺 server/port, 已忽略");
      continue;
    }
    out.push(p);
  }
  return out;
}

// include-all 的分组能吃到多少个节点(公告节点不算, 被 exclude-type 排掉的也不算)
function dynamicCount(group, usable, unknown) {
  if (!group["include-all"] && !group["include-all-proxies"]) return 0;
  if (unknown) return 9999;               // 有 proxy-providers 时无法静态判断
  const f = group.filter ? re(bare(group.filter)) : null;
  const x = group["exclude-filter"] ? re(bare(group["exclude-filter"])) : null;
  const xt = group["exclude-type"]
    ? String(group["exclude-type"]).toLowerCase().split("|") : null;
  let n = 0;
  for (let i = 0; i < usable.length; i++) {
    const p = usable[i];
    if (f && !f.test(p.name)) continue;
    if (x && x.test(p.name)) continue;
    if (xt && xt.indexOf(p.type) !== -1) continue;
    n++;
  }
  return n;
}

// 反复清理: 摘掉引用不存在的成员, 再摘掉彻底空掉的分组
function pruneGroups(groups, proxyNames, usable, unknown) {
  let changed = true;
  let live = groups.slice();
  while (changed) {
    changed = false;
    const names = live.map(function (g) { return g.name; });
    const valid = names.concat(BUILTIN, proxyNames);
    const next = [];
    for (let i = 0; i < live.length; i++) {
      const g = live[i];
      const kept = (g.proxies || []).filter(function (m) {
        return valid.indexOf(m) !== -1 && m !== g.name;
      });
      if ((g.proxies || []).length !== kept.length) changed = true;
      if (kept.length) g.proxies = kept; else delete g.proxies;
      if (kept.length + dynamicCount(g, usable, unknown) === 0) {
        say("分组「" + g.name + "」没有可用成员, 已移除");
        changed = true;
        continue;
      }
      next.push(g);
    }
    live = next;
  }
  return live;
}

// 挑出链里已注入的、目标是 DIRECT/REJECT 的规则 (merge 或规则覆写写进来的)
function keepUserRules(orig, providers, mine) {
  const keep = [];
  if (!Array.isArray(orig)) return keep;
  for (let i = 0; i < orig.length; i++) {
    const r = orig[i];
    if (typeof r !== "string" || !r.trim()) continue;
    const parts = r.split(",");
    if (parts.length < 3) continue;                       // MATCH,xxx 之类跳过
    const type = parts[0].trim().toUpperCase();
    if (type === "MATCH" || type === "FINAL" || type === "SUB-RULE") continue;
    if (type === "AND" || type === "OR" || type === "NOT") continue;
    const t = parts[targetIndex(parts)].trim().toUpperCase();
    if (KEEPABLE.indexOf(t) === -1) continue;             // 只保留直连/拦截
    if (type === "RULE-SET" && !has(providers, parts[1].trim())) continue;
    if (mine.indexOf(r) !== -1 || keep.indexOf(r) !== -1) continue;
    keep.push(r);
  }
  return keep;
}

// 目标分组不存在就回退; 规则集不存在就丢掉该规则
function fixRules(rules, valid, providers) {
  const out = [];
  const fb = valid.indexOf(OPT.fallback) !== -1 ? OPT.fallback : "DIRECT";
  for (let i = 0; i < rules.length; i++) {
    const parts = String(rules[i]).split(",");
    const type = parts[0].trim().toUpperCase();
    if (type === "RULE-SET" && !has(providers, parts[1].trim())) {
      say("规则集 " + parts[1].trim() + " 不存在, 丢弃规则: " + rules[i]);
      continue;
    }
    const idx = targetIndex(parts);
    const target = parts[idx].trim();
    if (valid.indexOf(target) === -1) {
      say("目标「" + target + "」不存在, 改为「" + fb + "」: " + rules[i]);
      parts[idx] = fb;
      out.push(parts.join(","));
      continue;
    }
    parts[idx] = target;
    out.push(parts.join(","));
  }
  return out;
}

/* ------------------------------ 10. 入口 --------------------------------- */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function enhance(config, profileName) {
  const tag = profileName ? "[" + profileName + "] " : "";
  const rawProxies = Array.isArray(config.proxies) ? config.proxies : [];
  const pp = config["proxy-providers"];
  const providerObj = (pp && typeof pp === "object") ? pp : {};
  const providerKeys = Object.keys(providerObj);
  if (!rawProxies.length && !providerKeys.length) {
    say(tag + "没有发现任何节点, 保持原配置不动");
    return config;
  }

  /* --- 节点 --- */
  const landing = validLandingNodes();
  config.proxies = normalizeProxies(rawProxies).concat(landing);
  const proxyNames = config.proxies.map(function (p) { return p.name; });
  const infoRe = re(INFO_PATTERN);
  const usable = [];   // 参与自动分组的节点: {name, type}
  for (let i = 0; i < config.proxies.length; i++) {
    const p = config.proxies[i];
    if (infoRe.test(p.name)) continue;
    usable.push({ name: p.name, type: String(p.type || "").toLowerCase() });
  }
  if (!usable.length && !providerKeys.length) {
    say(tag + "只识别到公告节点, 保持原配置不动");
    return config;
  }
  const unknown = providerKeys.length > 0 && usable.length === 0;

  /* --- 分组 --- */
  let groups = buildGroups();
  const landingRe = landing.length
    ? "^(?:" + landing.map(function (p) { return escapeRe(p.name); }).join("|") + ")$"
    : "";
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g["include-all"]) continue;
    // 自动分组统一剔除: 机场公告节点 + 落地节点(避免链式代理自己套自己)
    let ex = g["exclude-filter"] ? bare(g["exclude-filter"]) : "";
    ex = ex ? ex + "|" + INFO_PATTERN : INFO_PATTERN;
    if (landingRe) ex = ex + "|" + landingRe;
    g["exclude-filter"] = "(?i)" + ex;
  }
  groups = pruneGroups(groups, proxyNames, usable, unknown);

  /* --- 规则集 --- */
  const oldProviders = (config["rule-providers"] && typeof config["rule-providers"] === "object")
    ? config["rule-providers"] : {};
  const providers = Object.assign({}, oldProviders, RULE_PROVIDERS);

  /* --- 规则 --- */
  const groupNames = groups.map(function (g) { return g.name; });
  const valid = groupNames.concat(BUILTIN, proxyNames);
  const mine = buildRules();
  const kept = OPT.keepUserRules ? keepUserRules(config.rules, providers, mine) : [];
  if (kept.length) say(tag + "保留了 " + kept.length + " 条已有的直连/拦截规则");
  const rules = fixRules(kept.concat(mine), valid, providers);

  /* --- 写回 --- */
  config["proxy-groups"] = groups;
  config["rule-providers"] = providers;
  config.rules = rules;
  config.dns = DNS_CONFIG;
  config.sniffer = SNIFFER_CONFIG;
  const keys = Object.keys(GENERAL_CONFIG);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === "profile") continue;
    config[keys[i]] = GENERAL_CONFIG[keys[i]];
  }
  config.profile = Object.assign({}, config.profile || {}, GENERAL_CONFIG.profile);
  // 机场自带的这些字段可能引用已删除的分组, 一并清掉
  delete config["sub-rules"];
  delete config["script"];

  say(tag + "完成: " + config.proxies.length + " 节点 / " + groups.length +
      " 分组 / " + rules.length + " 条规则");
  return config;
}

function main(config, profileName) {
  if (!config || typeof config !== "object") return config;
  try {
    return enhance(config, profileName);
  } catch (e) {
    say("脚本执行出错, 已回退原始配置: " + e);
    return config;
  }
}














