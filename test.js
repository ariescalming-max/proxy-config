// 全局扩展脚本的离线校验器: 用真实订阅里的节点名跑一遍, 检查产物是否自洽
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SCRIPT = path.join(__dirname, "Script.js");
// Verge 的 profiles 目录: 从 APPDATA 推出来, 不写死用户名(换机器/发到公开仓库都能用)
const PROFILES = path.join(process.env.APPDATA || "",
  "io.github.clash-verge-rev.clash-verge-rev", "profiles");
const OUT = path.join(__dirname, "out");
const BUILTIN = ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE", "GLOBAL"];

function loadMain(src) {
  const ctx = { console: { log: () => {}, warn: () => {}, error: () => {} } };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;globalThis.__main = main;", ctx, { filename: "Script.js" });
  return ctx.__main;
}

function extractProxyNames(text) {
  const lines = text.split(/\r?\n/);
  let inProxies = false;
  const names = [];
  for (const line of lines) {
    if (/^proxies:\s*$/.test(line)) { inProxies = true; continue; }
    if (inProxies && /^[A-Za-z-]+:/.test(line)) { inProxies = false; continue; }
    if (!inProxies) continue;
    const m = line.match(/^\s*-\s*\{?\s*["']?name["']?\s*:\s*(.*)$/);
    if (!m) continue;
    let v = m[1].replace(/,\s*["']?[a-zA-Z-]+["']?\s*:.*$/, "").replace(/\}\s*$/, "").trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    if (v) names.push(v);
  }
  return names;
}

function mockProxies(names) {
  return names.map((n, i) => ({
    name: n, type: "ss", server: "127.0.0.1", port: 8388 + (i % 100),
    cipher: "aes-256-gcm", password: "test-only",
  }));
}

function mockConfig(names) {
  return {
    proxies: mockProxies(names),
    "proxy-groups": [
      { name: "🚀 节点选择", type: "select", proxies: ["♻️ 自动选择"].concat(names) },
      { name: "♻️ 自动选择", type: "url-test", proxies: names.slice(0, 3) },
    ],
    "rule-providers": { "airport-ads": { type: "http", behavior: "domain", url: "https://example.com/a.yaml", path: "./x.yaml" } },
    rules: [
      "PROCESS-NAME,crossfire.exe,DIRECT",
      "DOMAIN-SUFFIX,cf.qq.com,DIRECT",
      "RULE-SET,airport-ads,REJECT",
      "RULE-SET,ghost-set,DIRECT",
      "DOMAIN-SUFFIX,youtube.com,🚀 节点选择",
      "MATCH,🚀 节点选择",
    ],
  };
}

function jsRe(p) { return new RegExp(String(p).replace("(?i)", ""), "i"); }

function validate(cfg, label) {
  const errs = [];
  const groups = cfg["proxy-groups"] || [];
  const gnames = groups.map((g) => g.name);
  const pnames = (cfg.proxies || []).map((p) => p.name);
  const valid = gnames.concat(pnames, BUILTIN);
  const providers = cfg["rule-providers"] || {};

  const seen = new Set();
  for (const n of gnames) {
    if (seen.has(n)) errs.push(`分组重名: ${n}`);
    seen.add(n);
  }
  for (const n of pnames) {
    if (gnames.includes(n)) errs.push(`节点名与分组名冲突: ${n}`);
  }

  for (const g of groups) {
    let count = (g.proxies || []).length;
    for (const m of g.proxies || []) {
      if (!valid.includes(m)) errs.push(`分组 ${g.name} 引用了不存在的成员: ${m}`);
      if (m === g.name) errs.push(`分组 ${g.name} 自引用`);
    }
    for (const key of ["filter", "exclude-filter"]) {
      if (!g[key]) continue;
      try { jsRe(g[key]); } catch (e) { errs.push(`分组 ${g.name} ${key} 正则非法: ${e.message}`); }
      if (/\(\?[=!<]/.test(g[key])) errs.push(`分组 ${g.name} ${key} 用了 RE2 不支持的断言`);
    }
    if (g["include-all"]) {
      const f = g.filter ? jsRe(g.filter) : null;
      const x = g["exclude-filter"] ? jsRe(g["exclude-filter"]) : null;
      const xt = g["exclude-type"] ? String(g["exclude-type"]).toLowerCase().split("|") : null;
      count += (cfg.proxies || []).filter((p) =>
        (!f || f.test(p.name)) && (!x || !x.test(p.name)) &&
        (!xt || !xt.includes(String(p.type || "").toLowerCase()))).length;
    }
    if (count === 0) {
      // 有 proxy-providers 时, 订阅里的节点要运行时才拉到, include-all 组这里必然数成 0。
      // 这种情况不能算错 —— 脚本也是同样的理由不做裁剪。
      const hasProvider = Object.keys(cfg["proxy-providers"] || {}).length > 0;
      if (!(hasProvider && (g["include-all"] || g["include-all-proxies"])))
        errs.push(`分组 ${g.name} 没有任何成员 (mihomo 会报错)`);
    }
    if (!g.type) errs.push(`分组 ${g.name} 缺 type`);
  }
  return errs.concat(validateRules(cfg, valid, providers));
}

function validateRules(cfg, valid, providers) {
  const errs = [];
  const rules = cfg.rules || [];
  if (!/^MATCH,/.test(rules[rules.length - 1] || "")) errs.push("最后一条规则不是 MATCH");
  rules.forEach((r, i) => {
    const parts = String(r).split(",");
    const type = parts[0].trim().toUpperCase();
    if (type === "RULE-SET" && !providers[parts[1].trim()])
      errs.push(`规则 #${i} 引用了不存在的规则集: ${r}`);
    let ti = parts.length - 1;
    while (ti > 0 && ["no-resolve", "src"].includes(parts[ti].trim().toLowerCase())) ti--;
    if (!valid.includes(parts[ti].trim())) errs.push(`规则 #${i} 目标不存在: ${r}`);
    if (i < rules.length - 1 && (type === "MATCH" || type === "FINAL"))
      errs.push(`规则 #${i} 是中途 MATCH, 会吞掉后面的规则`);
  });
  return errs;
}

function regionSummary(cfg) {
  const names = cfg["proxy-groups"].filter((g) => /^(🇭🇰|🇹🇼|🇯🇵|🇸🇬|🇰🇷|🇺🇸|🇪🇺|🌐|🏠)/.test(g.name));
  return names.map((g) => {
    const f = g.filter ? jsRe(g.filter) : null;
    const x = g["exclude-filter"] ? jsRe(g["exclude-filter"]) : null;
    const hit = cfg.proxies.filter((p) => (!f || f.test(p.name)) && (!x || !x.test(p.name)));
    return `${g.name}:${hit.length}`;
  }).join("  ");
}

let fail = 0;
fs.mkdirSync(OUT, { recursive: true });
const src = fs.readFileSync(SCRIPT, "utf8");
const main = loadMain(src);

// ---- 场景 1: 6 个真实订阅 ----
const files = fs.readdirSync(PROFILES).filter((f) => /^R[\w]{11}\.yaml$/.test(f));
for (const f of files) {
  const names = extractProxyNames(fs.readFileSync(path.join(PROFILES, f), "utf8"));
  if (!names.length) { console.log(`--- ${f}: 未解析出节点, 跳过`); continue; }
  const cfg = main(mockConfig(names), f);
  if (!(cfg["proxy-groups"] || []).some((g) => g.name === "🔰 模式选择")) {
    console.log(`--- ${f}: 该订阅无可用节点(只有公告/失效节点), 脚本按设计原样返回 ✓`);
    continue;
  }
  const errs = validate(cfg, f);
  console.log(`--- ${f}  节点${cfg.proxies.length} 分组${cfg["proxy-groups"].length} 规则${cfg.rules.length}`);
  console.log(`    ${regionSummary(cfg)}`);
  if (errs.length) { fail++; errs.forEach((e) => console.log("    ✗ " + e)); }
  else console.log("    ✓ 自检通过");
  fs.writeFileSync(path.join(OUT, f.replace(/\.yaml$/, ".json")), JSON.stringify(cfg, null, 1));
}

// ---- 场景 2: 只有单一地区 + 公告节点 ----
{
  const names = ["剩余流量：100GB", "套餐到期：2026-09-10", "🇸🇬SG-01", "🇸🇬SG-02"];
  const cfg = main(mockConfig(names), "单地区");
  const errs = validate(cfg, "单地区");
  const gn = cfg["proxy-groups"].map((g) => g.name);
  console.log(`--- 单地区订阅  分组${gn.length}`);
  console.log(`    ${regionSummary(cfg)}`);
  const bad = gn.filter((n) => /^(🇭🇰|🇯🇵|🇺🇸|🇰🇷|🇹🇼|🇪🇺)/.test(n));
  if (bad.length) { fail++; console.log("    ✗ 不该出现的地区分组: " + bad.join(",")); }
  if (errs.length) { fail++; errs.forEach((e) => console.log("    ✗ " + e)); }
  else console.log("    ✓ 自检通过 (空地区分组已自动摘除)");
  fs.writeFileSync(path.join(OUT, "single-region.json"), JSON.stringify(cfg, null, 1));
}

// ---- 场景 3: 落地节点开启 ----
{
  const patched = src.replace(
    "const LANDING_NODES = [",
    'const LANDING_NODES = [{name:"🏠 落地-Test",type:"socks5",server:"1.2.3.4",port:1080,udp:true,"dialer-proxy":"⚙️ 节点选择"},'
  );
  const m2 = loadMain(patched);
  const cfg = m2(mockConfig(["🇯🇵JP-01", "🇺🇸US-01"]), "落地");
  const errs = validate(cfg, "落地");
  const landing = cfg["proxy-groups"].find((g) => g.name === "🕊️ 落地节点");
  const pick = cfg["proxy-groups"].find((g) => g.name === "⚙️ 节点选择");
  console.log("--- 落地节点场景");
  if (!landing) { fail++; console.log("    ✗ 落地节点分组没生成"); }
  if (!cfg.proxies.some((p) => p.name === "🏠 落地-Test")) { fail++; console.log("    ✗ 落地节点没写进 proxies"); }
  const ex = pick && pick["exclude-filter"] ? jsRe(pick["exclude-filter"]) : null;
  if (!ex || !ex.test("🏠 落地-Test")) { fail++; console.log("    ✗ ⚙️ 节点选择 没排除落地节点(会套娃死循环)"); }
  if (errs.length) { fail++; errs.forEach((e) => console.log("    ✗ " + e)); }
  else console.log("    ✓ 自检通过");
}

// ---- 场景 4: 只有 proxy-providers / 完全没有节点 ----
{
  const cfg = main({ "proxy-providers": { p1: { type: "http", url: "https://x", path: "./p1.yaml" } }, proxies: [] }, "providers");
  const ok = Array.isArray(cfg["proxy-groups"]) && cfg["proxy-groups"].length > 0;
  console.log(`--- 仅 providers: ${ok ? "✓ 生成了 " + cfg["proxy-groups"].length + " 个分组" : "✗ 没生成分组"}`);
  if (!ok) fail++;
  const empty = main({ proxies: [] }, "空");
  const untouched = !empty["proxy-groups"] && !empty.rules;
  console.log(`--- 空订阅: ${untouched ? "✓ 原样返回, 不会写坏配置" : "✗ 不该改动"}`);
  if (!untouched) fail++;
}

// ---- 场景 5: 明文 http 家宽节点 (对应 Rtm9qdgtSplr 那家) ----
{
  const proxies = [
    { name: "[HTTP·家宽·原生] 美国·弗吉尼亚州", type: "http", server: "127.0.0.1", port: 8080 },
    { name: "[HTTP·家宽·原生] 墨西哥·尤卡坦州", type: "http", server: "127.0.0.1", port: 8081 },
    { name: "🇯🇵JP-Reality", type: "ss", server: "127.0.0.1", port: 8388, cipher: "aes-256-gcm", password: "x" },
  ];
  const cfg = main({ proxies }, "明文节点");
  const errs = validate(cfg, "明文节点");
  const gg = (n) => cfg["proxy-groups"].find((g) => g.name === n);
  const hit = (g) => {
    if (!g) return [];
    const f = g.filter ? jsRe(g.filter) : null;
    const x = g["exclude-filter"] ? jsRe(g["exclude-filter"]) : null;
    const xt = g["exclude-type"] ? String(g["exclude-type"]).toLowerCase().split("|") : null;
    return proxies.filter((p) => (!f || f.test(p.name)) && (!x || !x.test(p.name)) &&
      (!xt || !xt.includes(p.type))).map((p) => p.name);
  };
  console.log("--- 明文 http 节点场景");
  const auto = hit(gg("♻️ 延迟选优"));
  const home = hit(gg("🏠 家宽原生"));
  const pick = hit(gg("⚙️ 节点选择"));
  console.log(`    ♻️ 延迟选优 拿到 ${auto.length} 个 (应为 1, 只剩加密节点)`);
  console.log(`    🏠 家宽原生 ${gg("🏠 家宽原生") ? "拿到 " + home.length + " 个" : "已摘除"}` +
    ` (OPT.plaintextInHome=false, 明文家宽被排除后组内为空 → 应摘除)`);
  console.log(`    ⚙️ 节点选择 拿到 ${pick.length} 个 (应为 3, 手动仍可选)`);
  if (auto.length !== 1 || gg("🏠 家宽原生") || pick.length !== 3) { fail++; console.log("    ✗ 明文排除逻辑不对"); }
  const mx = cfg["proxy-groups"].find((g) => g.name === "🌐 其他地区");
  if (mx && hit(mx).length === 0) { fail++; console.log("    ✗ 🌐 其他地区 被 exclude-type 排空了却没摘掉"); }
  if (errs.length) { fail++; errs.forEach((e) => console.log("    ✗ " + e)); }
  else console.log("    ✓ 自检通过");
  fs.writeFileSync(path.join(OUT, "plaintext.json"), JSON.stringify(cfg, null, 1));
}

// ---- 场景 6: 混合 proxies + proxy-providers (本地只有香港节点, 订阅在 provider 里) ----
{
  const cfg = main({
    proxies: [{ name: "🇭🇰 香港 01", type: "ss", server: "127.0.0.1", port: 8388, cipher: "aes-256-gcm", password: "x" }],
    "proxy-providers": { airport: { type: "http", url: "https://x", path: "./p.yaml", interval: 3600 } },
    rules: ["MATCH,DIRECT"],
  }, "混合");
  const names = cfg["proxy-groups"].map((g) => g.name);
  const need = ["🇯🇵 日本", "🇺🇸 美国", "🇸🇬 新加坡", "🌐 其他地区"];
  const miss = need.filter((n) => !names.includes(n));
  console.log("--- 混合 proxies + providers");
  if (miss.length) { fail++; console.log("    ✗ 地区分组被误删: " + miss.join(" ")); }
  else console.log(`    ✓ 地区分组全部保留 (共 ${names.length} 组, 不按本地节点裁剪)`);
  if (validate(cfg, "混合").length) { fail++; console.log("    ✗ 自检不通过"); }
}

// ---- 场景 7: 保留的机场规则要插在广告规则之后, 宽泛国内直连要排在 fix-proxy 之后 ----
{
  const cfg = main({
    proxies: mockProxies(["🇯🇵JP-01"]),
    "rule-providers": { ChinaDomain: { type: "http", behavior: "domain", url: "https://x/y.yaml", path: "./y.yaml" } },
    rules: [
      "GEOIP,CN,DIRECT", "GEOSITE,cn,DIRECT", "RULE-SET,ChinaDomain,DIRECT",
      "DOMAIN-SUFFIX,airport-panel.com,DIRECT", "GEOIP,PRIVATE,DIRECT", "MATCH,DIRECT",
    ],
  }, "保留规则");
  const rules = cfg.rules;
  const at = (re) => rules.findIndex((r) => re.test(r));
  const iAds = at(/^RULE-SET,ads,/);
  const iPanel = at(/^DOMAIN-SUFFIX,airport-panel\.com,/);
  const iPriv = at(/^GEOIP,PRIVATE,/);
  const iAI = at(/^RULE-SET,anthropic,/);
  const iFix = at(/^RULE-SET,fix-proxy,/);
  const iGeo = at(/^GEOIP,CN,DIRECT/);
  const iSite = at(/^GEOSITE,cn,DIRECT/);
  const iSet = at(/^RULE-SET,ChinaDomain,DIRECT/);
  const iCn = at(/^RULE-SET,cn,/);
  console.log("--- 保留的机场规则位置");
  const checks = [
    [iAds >= 0 && iPanel > iAds && iPanel < iAI,
      `具体规则要在 ads 之后、AI 之前 (ads@${iAds} < 面板域名@${iPanel} < AI@${iAI})`],
    [iPriv > iAds && iPriv < iAI, `GEOIP,PRIVATE 不算宽泛国内直连, 留在前面 (@${iPriv})`],
    [iGeo > iFix && iSite > iFix && iSet > iFix,
      `宽泛国内直连要排在 fix-proxy 之后 (fix@${iFix} < GEOIP,CN@${iGeo}, GEOSITE,cn@${iSite}, ChinaDomain@${iSet})`],
    [iGeo < iCn && iSite < iCn && iSet < iCn, `且仍在脚本自己的国内直连段里 (< cn@${iCn})`],
  ];
  for (const [ok, msg] of checks) {
    if (!ok) { fail++; console.log("    ✗ " + msg); } else console.log("    ✓ " + msg);
  }
  if (validate(cfg, "保留规则").length) { fail++; console.log("    ✗ 自检不通过"); }
}

// ---- 场景 8: 深拷贝 —— 不该改动调用方传进来的对象 ----
{
  const orig = { proxies: mockProxies(["🇯🇵JP-01"]), rules: ["MATCH,DIRECT"] };
  const before = JSON.stringify(orig);
  const out = main(orig, "深拷贝");
  console.log("--- 深拷贝 / 出错回退");
  if (JSON.stringify(orig) !== before) { fail++; console.log("    ✗ 原对象被改了(出错时无法真正回退)"); }
  else console.log("    ✓ 原对象未被改动");
  if (!out["proxy-groups"] || !out["proxy-groups"].length) { fail++; console.log("    ✗ 返回的副本没生成分组"); }
  // 不可序列化的配置: 应原样放行, 而不是原地改出半成品
  const weird = { proxies: mockProxies(["🇯🇵JP-01"]), rules: ["MATCH,DIRECT"] };
  weird.self = weird;                                  // 循环引用
  const out2 = main(weird, "循环引用");
  if (out2["proxy-groups"]) { fail++; console.log("    ✗ 不可序列化的配置被改了, 应原样返回"); }
  else console.log("    ✓ 不可序列化的配置原样返回");
}

// ---- 场景 9: Copilot / 欧洲正则 / 「禁止BT」节点 ----
{
  const proxies = mockProxies(["🇯🇵 日本 01 禁止BT", "欧洲 01", "EU-02", "Europe-03", "🇩🇪 德国 04"]);
  const cfg = main({ proxies, rules: ["MATCH,DIRECT"] }, "杂项");
  const gg = (n) => cfg["proxy-groups"].find((g) => g.name === n);
  console.log("--- Copilot / 欧洲 / 禁止BT");
  const hasCopilotSet = (cfg.rules || []).some((r) => /^RULE-SET,copilot,/.test(r));
  const hasCopilotDom = (cfg.rules || []).some((r) => /copilot\.microsoft\.com/.test(r));
  const iCop = cfg.rules.findIndex((r) => /copilot/i.test(r));
  const iMs = cfg.rules.findIndex((r) => /^RULE-SET,microsoft,/.test(r));
  if (!hasCopilotSet || !hasCopilotDom) { fail++; console.log("    ✗ Copilot 规则缺失"); }
  else if (!(iCop < iMs)) { fail++; console.log(`    ✗ Copilot@${iCop} 没抢在 microsoft@${iMs} 前面`); }
  else console.log(`    ✓ Copilot 规则齐全且在 microsoft 之前 (${iCop} < ${iMs})`);
  const eu = gg("🇪🇺 欧洲");
  const euRe = eu && eu.filter ? jsRe(eu.filter) : null;
  const euMiss = ["欧洲 01", "EU-02", "Europe-03", "🇩🇪 德国 04"].filter((n) => !euRe || !euRe.test(n));
  if (euMiss.length) { fail++; console.log("    ✗ 欧洲组认不出: " + euMiss.join(" ")); }
  else console.log("    ✓ 欧洲组认得 欧洲 / EU / Europe / 国名");
  const jp = gg("🇯🇵 日本");
  const jpEx = jp && jp["exclude-filter"] ? jsRe(jp["exclude-filter"]) : null;
  if (jpEx && jpEx.test("🇯🇵 日本 01 禁止BT")) { fail++; console.log("    ✗ 「禁止BT」真节点被当成公告条目排除了"); }
  else console.log("    ✓ 「禁止BT」节点没被误杀");
  if (validate(cfg, "杂项").length) { fail++; console.log("    ✗ 自检不通过"); }
}

// ---- 场景 10: AI 组默认候选 + 腾讯广告域名不被宽后缀直连放行 ----
{
  const cfg = main({ proxies: mockProxies(["🇯🇵JP-01", "🇺🇸US-01", "🏠 美国家宽 ISP"]), rules: ["MATCH,DIRECT"] }, "默认候选");
  const ai = cfg["proxy-groups"].find((g) => /ChatGPT/.test(g.name));
  const cl = cfg["proxy-groups"].find((g) => /Claude/.test(g.name));
  console.log("--- AI 默认候选 / 腾讯广告域名顺序");
  if (!ai || ai.proxies[0] !== "🇯🇵 日本") { fail++; console.log(`    ✗ AI 组默认候选是 ${ai && ai.proxies[0]}, 应为 🇯🇵 日本`); }
  else if (!cl || cl.proxies[0] !== "🇯🇵 日本") { fail++; console.log(`    ✗ Claude 组默认候选是 ${cl && cl.proxies[0]}`); }
  else console.log("    ✓ AI / Claude 默认候选都是 🇯🇵 日本(不是可能为空的家宽组)");
  const iAd = cfg.rules.findIndex((r) => /^DOMAIN-SUFFIX,pgdt\.gtimg\.com,/.test(r));
  const iDirect = cfg.rules.findIndex((r) => /^DOMAIN-SUFFIX,gtimg\.com,/.test(r));
  if (!(iAd >= 0 && iDirect > iAd)) {
    fail++;
    console.log(`    ✗ pgdt.gtimg.com@${iAd} 没抢在 gtimg.com 直连@${iDirect} 前面`);
  } else console.log(`    ✓ pgdt.gtimg.com@${iAd} < gtimg.com 直连@${iDirect}`);
}

// ---- 场景 11: 新增规则集的顺序(广告补充 / CDN 直连 / 国外域名修正) ----
{
  const cfg = main({ proxies: mockProxies(["🇯🇵JP-01"]), rules: ["MATCH,DIRECT"] }, "新增规则集");
  const rules = cfg.rules;
  const at = (re) => rules.findIndex((r) => re.test(r));
  const provs = cfg["rule-providers"] || {};
  console.log("--- 新增规则集");
  const need = ["ad-program", "fix-proxy", "fix-proxy-ip", "cdn-game", "cdn-game-ip"];
  const missing = need.filter((k) => !provs[k]);
  if (missing.length) { fail++; console.log("    ✗ rule-providers 缺: " + missing.join(" ")); }
  else console.log(`    ✓ 5 个新规则集都在 (共 ${Object.keys(provs).length} 个)`);
  // Steam CDN 表已并入 cdn-game(上游内容重复), 不该再单独下载
  const dropped = ["cdn-steam", "cdn-steam-ip"].filter((k) => provs[k]);
  if (dropped.length) { fail++; console.log("    ✗ 重复的 Steam CDN 表又回来了: " + dropped.join(" ")); }
  else console.log("    ✓ 重复的 Steam CDN 表已并入 cdn-game");
  // 浏览器已有 uBlock, 网页广告表不该被启用
  const shouldBeOff = ["ad-cn", "ad-easylist", "ad-privacy"].filter((k) => provs[k]);
  if (shouldBeOff.length) { fail++; console.log("    ✗ 网页广告表不该启用: " + shouldBeOff.join(" ")); }
  else console.log("    ✓ 网页广告表保持关闭(uBlock 已覆盖, 避免更差的重复)");
  // behavior 要对: _ip 结尾的必须是 ipcidr
  const badBehavior = need.filter((k) => provs[k] &&
    ((/-ip$/.test(k) && provs[k].behavior !== "ipcidr") || (!/-ip$/.test(k) && provs[k].behavior !== "domain")));
  if (badBehavior.length) { fail++; console.log("    ✗ behavior 不对: " + badBehavior.join(" ")); }
  else console.log("    ✓ behavior 全部正确 (域名表 domain / 网段表 ipcidr)");
  // 顺序: 广告补充紧跟 ads; CDN 早于 steam/games; fix-proxy 早于 cn 直连
  const iAds = at(/^RULE-SET,ads,/), iAdEasy = at(/^RULE-SET,ad-program,/);
  const iCdn = at(/^RULE-SET,cdn-game,/), iSteam = at(/^RULE-SET,steam,/), iGames = at(/^RULE-SET,games,/);
  const iFix = at(/^RULE-SET,fix-proxy,/), iCn = at(/^RULE-SET,cn,/), iGeo = at(/^GEOIP,CN,/);
  const checks = [
    [iAds < iAdEasy, `广告补充要在 ads 之后 (ads@${iAds} < ad-program@${iAdEasy})`],
    [iCdn < iSteam && iCdn < iGames, `CDN 直连要早于 steam/games (cdn@${iCdn} < steam@${iSteam}, games@${iGames})`],
    [iFix < iCn && iFix < iGeo, `国外域名修正要早于国内直连 (fix@${iFix} < cn@${iCn}, GEOIP@${iGeo})`],
  ];
  for (const [ok, msg] of checks) {
    if (!ok) { fail++; console.log("    ✗ " + msg); } else console.log("    ✓ " + msg);
  }
  if (validate(cfg, "新增规则集").length) { fail++; console.log("    ✗ 自检不通过"); }
}

// ---- 场景 12: 节点名撞车 (节点之间 / 内置策略 / 分组名 / 落地节点) ----
{
  const dup = (names) => {
    const cfg = main({ proxies: mockProxies(names), rules: ["MATCH,DIRECT"] }, "重名");
    return { cfg, names: cfg.proxies.map((p) => p.name) };
  };
  const conflicts = (cfg) => {
    const pn = cfg.proxies.map((p) => p.name);
    const gn = cfg["proxy-groups"].map((g) => g.name);
    return pn.filter((n, i) => pn.indexOf(n) !== i)
      .concat(pn.filter((n) => gn.includes(n)))
      .concat(pn.filter((n) => BUILTIN.includes(n)));
  };
  console.log("--- 节点名撞车");
  const cases = [
    ["订阅里已有 JP #2", ["JP #2", "JP", "JP"]],
    ["节点名叫 DIRECT", ["DIRECT", "🇯🇵JP-01"]],
    ["节点名撞分组名", ["🔰 模式选择", "🇯🇵 日本", "🇯🇵JP-01"]],
    ["普通三重名", ["JP", "JP", "JP"]],
  ];
  for (const [label, names] of cases) {
    const { cfg, names: out } = dup(names);
    const bad = conflicts(cfg);
    if (bad.length) { fail++; console.log(`    ✗ ${label}: 仍然撞车 ${bad.join(",")} → ${JSON.stringify(out)}`); }
    else console.log(`    ✓ ${label} → ${JSON.stringify(out)}`);
    if (validate(cfg, label).length) { fail++; console.log(`    ✗ ${label}: 自检不通过`); }
  }
  // 落地节点的名字优先: 订阅里的同名节点该被改名, 落地组仍指得到
  const patched = src.replace(
    "const LANDING_NODES = [",
    'const LANDING_NODES = [{name:"🏠 落地-Test",type:"socks5",server:"1.2.3.4",port:1080,udp:true},'
  );
  const cfg2 = loadMain(patched)({ proxies: mockProxies(["🏠 落地-Test", "🇯🇵JP-01"]), rules: ["MATCH,DIRECT"] }, "落地撞名");
  const pn2 = cfg2.proxies.map((p) => p.name);
  const land = cfg2["proxy-groups"].find((g) => g.name === "🕊️ 落地节点");
  const okLand = land && land.proxies.includes("🏠 落地-Test") &&
    pn2.filter((n) => n === "🏠 落地-Test").length === 1;
  if (!okLand) { fail++; console.log(`    ✗ 落地节点撞名处理不对 → ${JSON.stringify(pn2)}`); }
  else console.log(`    ✓ 落地节点名保住, 订阅那个改名 → ${JSON.stringify(pn2)}`);
  if (validate(cfg2, "落地撞名").length) { fail++; console.log("    ✗ 落地撞名: 自检不通过"); }

  // 手写的落地节点自己也可能撞车: 叫 DIRECT / 跟落地组同名 / 两个同名
  const bad = [
    '{name:"DIRECT",type:"socks5",server:"1.2.3.4",port:1080}',
    '{name:"🕊️ 落地节点",type:"socks5",server:"1.2.3.5",port:1080}',
    '{name:"🏠 落地-A",type:"socks5",server:"1.2.3.6",port:1080}',
    '{name:"🏠 落地-A",type:"socks5",server:"1.2.3.7",port:1080}',
    '{name:"  ",type:"socks5",server:"1.2.3.8",port:1080}',      // 空名, 该丢
    '{name:"🏠 落地-无端口",type:"socks5",server:"1.2.3.9"}',      // 缺 port, 该丢
  ].join(",");
  const cfg3 = loadMain(src.replace("const LANDING_NODES = [", "const LANDING_NODES = [" + bad + ","))(
    { proxies: mockProxies(["🇯🇵JP-01"]), rules: ["MATCH,DIRECT"] }, "落地自撞");
  const pn3 = cfg3.proxies.map((p) => p.name);
  const gn3 = cfg3["proxy-groups"].map((g) => g.name);
  const land3 = cfg3["proxy-groups"].find((g) => g.name === "🕊️ 落地节点");
  const bad3 = pn3.filter((n, i) => pn3.indexOf(n) !== i)
    .concat(pn3.filter((n) => gn3.includes(n) || BUILTIN.includes(n)));
  const dropped = pn3.some((n) => n === "  " || /无端口/.test(n));
  const linked = land3 && land3.proxies.every((m) => pn3.includes(m)) && land3.proxies.length === 4;
  if (bad3.length) { fail++; console.log(`    ✗ 手写落地节点仍然撞车: ${bad3.join(",")} → ${JSON.stringify(pn3)}`); }
  else console.log(`    ✓ 手写落地节点已去重/避开保留名 → ${JSON.stringify(pn3)}`);
  if (dropped) { fail++; console.log("    ✗ 空名/缺 port 的落地节点没被丢掉"); }
  if (!linked) { fail++; console.log(`    ✗ 落地组成员与改名后的节点对不上 → ${JSON.stringify(land3 && land3.proxies)}`); }
  else console.log(`    ✓ 落地组 ${land3.proxies.length} 个成员都指得到`);
  if (validate(cfg3, "落地自撞").length) { fail++; console.log("    ✗ 落地自撞: 自检不通过"); }
}

// ---- 场景 13: 写坏的域名规则 (手写覆写里常见 DOMAIN,http://x/ ) ----
{
  const cfg = main({
    proxies: mockProxies(["🇯🇵JP-01"]),
    rules: [
      "DOMAIN,http://hybgzs.com/,DIRECT",              // 带协议+斜杠, 应修正成主机名
      "DOMAIN-SUFFIX,https://Panel.Example.COM/path,DIRECT", // 同上, 还要转小写
      "DOMAIN,example.org.,DIRECT",                    // 末尾多余的点
      "DOMAIN-SUFFIX,   ,DIRECT",                      // 空值, 应丢掉
      "DOMAIN-KEYWORD,bad host,DIRECT",                // 带空格, 应丢掉
      "DOMAIN-SUFFIX,ok-domain.com,DIRECT",            // 正常的不该被动
      "MATCH,DIRECT",
    ],
  }, "坏域名");
  const rules = cfg.rules;
  const hasR = (re) => rules.some((r) => re.test(r));
  console.log("--- 写坏的域名规则");
  const checks = [
    [hasR(/^DOMAIN,hybgzs\.com,DIRECT$/) && !hasR(/http:\/\//), "DOMAIN,http://hybgzs.com/ → DOMAIN,hybgzs.com"],
    [hasR(/^DOMAIN-SUFFIX,panel\.example\.com,DIRECT$/), "带路径+大写的域名已规范化"],
    [hasR(/^DOMAIN,example\.org,DIRECT$/), "末尾多余的点已去掉"],
    [!hasR(/^DOMAIN-SUFFIX,\s*,/), "空域名的规则已丢掉"],
    [!hasR(/bad host/), "带空格的关键词规则已丢掉"],
    [hasR(/^DOMAIN-SUFFIX,ok-domain\.com,DIRECT$/), "正常规则原样保留"],
  ];
  for (const [ok, msg] of checks) {
    if (!ok) { fail++; console.log("    ✗ " + msg); } else console.log("    ✓ " + msg);
  }
  if (validate(cfg, "坏域名").length) { fail++; console.log("    ✗ 自检不通过"); }
}

console.log(fail ? `\n结果: ${fail} 项失败` : "\n结果: 全部通过");
process.exit(fail ? 1 : 0);
