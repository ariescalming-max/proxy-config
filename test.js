// 全局扩展脚本的离线校验器: 用真实订阅里的节点名跑一遍, 检查产物是否自洽
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SCRIPT = path.join(__dirname, "Script.js");
const PROFILES = "C:/Users/Aries/AppData/Roaming/io.github.clash-verge-rev.clash-verge-rev/profiles";
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
    if (count === 0) errs.push(`分组 ${g.name} 没有任何成员 (mihomo 会报错)`);
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
  console.log(`    🏠 家宽原生 拿到 ${home.length} 个 (应为 2, 解锁用的明文家宽保留)`);
  console.log(`    ⚙️ 节点选择 拿到 ${pick.length} 个 (应为 3, 手动仍可选)`);
  if (auto.length !== 1 || home.length !== 2 || pick.length !== 3) { fail++; console.log("    ✗ 明文排除逻辑不对"); }
  const mx = cfg["proxy-groups"].find((g) => g.name === "🌐 其他地区");
  if (mx && hit(mx).length === 0) { fail++; console.log("    ✗ 🌐 其他地区 被 exclude-type 排空了却没摘掉"); }
  if (errs.length) { fail++; errs.forEach((e) => console.log("    ✗ " + e)); }
  else console.log("    ✓ 自检通过");
  fs.writeFileSync(path.join(OUT, "plaintext.json"), JSON.stringify(cfg, null, 1));
}

console.log(fail ? `\n结果: ${fail} 项失败` : "\n结果: 全部通过");
process.exit(fail ? 1 : 0);
