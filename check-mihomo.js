// 用 mihomo 内核原生跑一遍 `-t`(只校验配置, 不联网不起代理)。
// JS 自检只能证明结构自洽; 节点重名、字段约束这类只有内核自己会报。
// 用法: node check-mihomo.js          (缺内核就跳过, 不算失败)
// 首次运行会在 .mihomo-check/ 下攒一份 geo 库 + ruleset 缓存(借 Verge 的, 约 50MB),
// 为的是 -t 时不去外网拉表(会超时)。不想留着就 rm -rf .mihomo-check。
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const HERE = __dirname;
const STAGE = path.join(HERE, ".mihomo-check");   // 内核的 home 目录(geo 库 + ruleset 缓存)
const CASES = path.join(STAGE, "cases");
const VERGE = path.join(process.env.APPDATA || "",
  "io.github.clash-verge-rev.clash-verge-rev");
const PROFILES = path.join(VERGE, "profiles");
const EXES = [
  "D:/Program Files/Clash Verge/verge-mihomo.exe",
  "C:/Program Files/Clash Verge/verge-mihomo.exe",
  path.join(process.env.LOCALAPPDATA || "", "Programs/Clash Verge/verge-mihomo.exe"),
  "mihomo", "mihomo.exe",
];

function findExe() {
  for (const e of EXES) {
    try {
      execFileSync(e, ["-v"], { stdio: "pipe", timeout: 15000 });
      return e;
    } catch (err) { /* 换下一个 */ }
  }
  return null;
}

// geo 库和已下载的规则集直接借 Verge 的, 避免 -t 时去外网拉(会超时)
function stage() {
  fs.mkdirSync(CASES, { recursive: true });
  for (const f of ["Country.mmdb", "geoip.dat", "geosite.dat", "ASN.mmdb"]) {
    const src = path.join(VERGE, f), dst = path.join(STAGE, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
  }
  const rs = path.join(VERGE, "ruleset");
  if (fs.existsSync(rs) && !fs.existsSync(path.join(STAGE, "ruleset")))
    fs.cpSync(rs, path.join(STAGE, "ruleset"), { recursive: true });
}

function loadMain(src) {
  const ctx = { console: { log: () => {}, warn: () => {}, error: () => {} } };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;globalThis.__main = main;", ctx, { filename: "Script.js" });
  return ctx.__main;
}

// 订阅 yaml 的粗解析: 只取 proxies 的名字 / rules 列表 / rule-providers 的键名
function section(text, head, pick) {
  const lines = text.split(/\r?\n/);
  let on = false;
  const out = [];
  for (const l of lines) {
    if (new RegExp("^" + head + ":\\s*$").test(l)) { on = true; continue; }
    // 段落结束 = 出现下一个顶层键。注意顶格写的列表项(- DOMAIN,...)和顶格注释都不算
    if (on && /^\S/.test(l) && !/^[-#]/.test(l)) { on = false; continue; }
    if (!on) continue;
    const v = pick(l);
    if (v) out.push(v);
  }
  return out;
}
const pickName = (l) => {
  const m = l.match(/^\s*-\s*\{?\s*["']?name["']?\s*:\s*(.*)$/);
  if (!m) return null;
  let v = m[1].replace(/,\s*["']?[a-zA-Z-]+["']?\s*:.*$/, "").replace(/\}\s*$/, "").trim();
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
  return v || null;
};
const pickRule = (l) => {
  const m = l.match(/^\s*-\s*(.+?)\s*$/);
  if (!m) return null;
  let v = m[1].trim();
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
  return v || null;
};
const pickProvider = (l) => {
  const m = l.match(/^\s{2}["']?([\w.-]+)["']?:\s*$/);
  return m ? m[1] : null;
};

const mock = (n) => ({
  name: n, type: "ss", server: "127.0.0.1", port: 8388,
  cipher: "aes-256-gcm", password: "test-only",
});
// 订阅里的 rule-provider 都指到本地已有的 site-cn.mrs, 免得 -t 时去下载
const localProvider = () => ({
  type: "http", behavior: "domain", format: "mrs", interval: 86400,
  url: "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/cn.mrs",
  path: "./ruleset/mihomo/site-cn.mrs",
});

function buildCases(src, main) {
  const cases = [];
  // 1) 真实订阅: 节点名 + 规则 + rule-providers 全用真的
  if (fs.existsSync(PROFILES)) {
    for (const f of fs.readdirSync(PROFILES).filter((x) => /^R[\w]{11}\.yaml$/.test(x))) {
      const t = fs.readFileSync(path.join(PROFILES, f), "utf8");
      const names = section(t, "proxies", pickName);
      if (!names.length) continue;
      const rp = {};
      for (const k of section(t, "rule-providers", pickProvider)) rp[k] = localProvider();
      cases.push([f.replace(/\.yaml$/, ""), {
        proxies: names.map(mock), "rule-providers": rp,
        rules: section(t, "rules", pickRule),
      }]);
    }
  }
  // 2) 撞名: 节点之间重名 + 内置策略名 + 分组名
  cases.push(["撞名节点", {
    proxies: ["JP #2", "JP", "JP", "DIRECT", "REJECT", "🔰 模式选择", "🇯🇵 日本"].map(mock),
    rules: ["MATCH,DIRECT"],
  }]);
  // 3) 明文 http 家宽 + 写坏的域名规则
  cases.push(["明文与坏规则", {
    proxies: [
      { name: "[HTTP·家宽·原生] 美国", type: "http", server: "127.0.0.1", port: 8080 },
      mock("🇯🇵JP-Reality"),
    ],
    rules: ["DOMAIN,http://hybgzs.com/,DIRECT", "GEOIP,CN,DIRECT", "MATCH,DIRECT"],
  }]);
  // 4) 手写的落地节点自己撞车: 叫 DIRECT / 跟落地组同名 / 两个同名
  const bad = [
    '{name:"DIRECT",type:"socks5",server:"127.0.0.1",port:1080}',
    '{name:"🕊️ 落地节点",type:"socks5",server:"127.0.0.1",port:1081}',
    '{name:"🏠 落地-A",type:"socks5",server:"127.0.0.1",port:1082}',
    '{name:"🏠 落地-A",type:"socks5",server:"127.0.0.1",port:1083}',
  ].join(",");
  cases.push(["落地节点撞名",
    { proxies: [mock("🇯🇵JP-01")], rules: ["MATCH,DIRECT"] },
    loadMain(src.replace("const LANDING_NODES = [", "const LANDING_NODES = [" + bad + ","))]);
  return cases;
}

// 顺序体检: 保留下来的宽泛国内直连必须排在 fix-proxy 之后, 否则国外域名会被误判直连
function order(cfg) {
  const rules = cfg.rules || [];
  const at = (re) => rules.findIndex((r) => re.test(r));
  const iFix = at(/^RULE-SET,fix-proxy,/);
  const iCn = at(/^RULE-SET,cn,/);
  const broad = [];
  rules.forEach((r, i) => {
    if (/^(GEOIP,CN|GEOSITE,cn|RULE-SET,[Cc]hina[\w-]*),(DIRECT|PASS)/.test(r)) broad.push([i, r]);
  });
  if (!broad.length) { console.log(`    保留的宽泛国内直连: 无 (fix-proxy@${iFix} < cn@${iCn})`); return; }
  const bad = broad.filter(([i]) => i < iFix);
  for (const [i, r] of broad) console.log(`    保留的宽泛国内直连 @${i}: ${r}`);
  console.log(bad.length
    ? `    ✗ 有 ${bad.length} 条排在 fix-proxy@${iFix} 前面, 会抢先判直连`
    : `    ✓ 都排在 fix-proxy@${iFix} 之后、脚本自己的 cn@${iCn} 之前`);
}

const exe = findExe();
if (!exe) {
  console.log("没找到 mihomo 内核(找过 Clash Verge 安装目录和 PATH), 跳过原生校验");
  process.exit(0);
}
console.log(execFileSync(exe, ["-v"], { encoding: "utf8" }).split("\n")[0]);
stage();
const src = fs.readFileSync(path.join(HERE, "Script.js"), "utf8");
const main = loadMain(src);
const cases = buildCases(src, main);
let fail = 0;
for (const [name, input, altMain] of cases) {
  const cfg = (altMain || main)(JSON.parse(JSON.stringify(input)), name);
  if (!cfg["proxy-groups"]) { console.log(`--- ${name}: 脚本原样返回(无可用节点), 跳过`); continue; }
  cfg["geo-auto-update"] = false;         // -t 时不要去外网更新 geo 库
  cfg["external-controller"] = "";
  const file = path.join(CASES, name.replace(/[^\w一-龥-]/g, "_") + ".yaml");
  fs.writeFileSync(file, JSON.stringify(cfg, null, 1));   // JSON 是 YAML 的子集
  let out = "";
  let ok = false;
  try {
    out = execFileSync(exe, ["-t", "-d", STAGE, "-f", file],
      { encoding: "utf8", timeout: 60000, stdio: "pipe" });
    ok = true;
  } catch (e) {
    out = String((e.stdout || "") + (e.stderr || ""));
  }
  const errs = out.split(/\r?\n/).filter((l) => /level=(error|fatal)/.test(l))
    .map((l) => l.replace(/^time="[^"]*"\s*/, "").replace(/&[^ "]*/g, "").slice(0, 160));
  console.log(`--- ${name}  节点${cfg.proxies.length} 分组${cfg["proxy-groups"].length} 规则${cfg.rules.length}`);
  order(cfg);
  if (ok && !errs.length) console.log("    ✓ 内核校验通过");
  else {
    fail++;
    console.log("    ✗ 内核报错:");
    for (const e of errs.slice(0, 5)) console.log("      " + e);
    if (!errs.length) console.log("      " + out.trim().split(/\r?\n/).slice(-2).join(" | ").slice(0, 200));
  }
}
console.log(fail ? `\n结果: ${fail} 份配置被内核拒绝` : "\n结果: 全部通过内核校验");
process.exit(fail ? 1 : 0);
