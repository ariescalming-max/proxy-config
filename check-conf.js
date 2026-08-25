// Shadowrocket.conf 静态校验: 策略引用 / 分组成员 / 正则 / 规则集链接可达性
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "SR.conf");
const BUILTIN = ["DIRECT", "REJECT", "REJECT-DROP", "PROXY"];
const RULE_FLAGS = ["no-resolve", "force-remote-dns", "pre-matching", "extended-matching"];
const TYPES = ["select", "url-test", "fallback", "load-balance", "random", "ssid"];

const text = fs.readFileSync(FILE, "utf8");
const lines = text.split(/\r?\n/);
let section = "";
const groups = [];   // {name, type, members[], opts{}}
const rules = [];    // {line, policy, no, type}
lines.forEach((raw, i) => {
  const l = raw.trim();
  if (!l || l.startsWith("#")) return;
  const s = l.match(/^\[(.+)\]$/);
  if (s) { section = s[1]; return; }
  if (section === "Proxy Group") {
    const m = l.match(/^([^=]+?)\s*=\s*(.+)$/);
    if (!m) return;
    const parts = m[2].split(",").map((x) => x.trim());
    const g = { name: m[1].trim(), type: parts[0], members: [], opts: {}, no: i + 1 };
    parts.slice(1).forEach((p) => {
      const kv = p.match(/^([a-z-]+)\s*=\s*(.*)$/);
      if (kv) g.opts[kv[1]] = kv[2]; else if (p) g.members.push(p);
    });
    groups.push(g);
  } else if (section === "Rule") {
    const parts = l.split(",").map((x) => x.trim());
    let idx = parts.length - 1;
    while (idx > 0 && RULE_FLAGS.includes(parts[idx])) idx--;
    rules.push({ line: l, type: parts[0], policy: parts[idx], no: i + 1, parts });
  }
});

const errs = [];
const names = groups.map((g) => g.name);
const valid = names.concat(BUILTIN);
names.forEach((n, i) => { if (names.indexOf(n) !== i) errs.push(`分组重名: ${n}`); });
groups.forEach((g) => {
  if (!TYPES.includes(g.type)) errs.push(`L${g.no} 分组 ${g.name} 类型不认识: ${g.type}`);
  g.members.forEach((m) => {
    if (!valid.includes(m)) errs.push(`L${g.no} 分组 ${g.name} 引用了不存在的成员: ${m}`);
    if (m === g.name) errs.push(`L${g.no} 分组 ${g.name} 自引用`);
  });
  if (!g.members.length && !g.opts["policy-regex-filter"] && !g.opts["policy-path"])
    errs.push(`L${g.no} 分组 ${g.name} 既没有成员也没有 filter, 会是空组`);
  const f = g.opts["policy-regex-filter"];
  if (f) {
    try { new RegExp(f); } catch (e) { errs.push(`L${g.no} ${g.name} 正则非法: ${e.message}`); }
    if (/\(\?<[=!]/.test(f)) errs.push(`L${g.no} ${g.name} 用了后向断言, 风险高`);
  }
  if ((g.type === "url-test" || g.type === "fallback") && !g.opts.url)
    errs.push(`L${g.no} ${g.name} 是 ${g.type} 但没写 url=, 不会做健康检查`);
});
// 规则检查
const last = rules[rules.length - 1];
if (!last || last.type !== "FINAL") errs.push("最后一条不是 FINAL");
rules.forEach((r, i) => {
  if (!valid.includes(r.policy)) errs.push(`L${r.no} 策略不存在: ${r.line.slice(0, 60)}`);
  if (r.type === "FINAL" && i !== rules.length - 1) errs.push(`L${r.no} FINAL 不在最后, 会吞掉后面的规则`);
  if (r.type === "RULE-SET" && !/^https?:\/\//.test(r.parts[1]) && !["SYSTEM", "LAN"].includes(r.parts[1]))
    errs.push(`L${r.no} RULE-SET 的来源看不懂: ${r.parts[1]}`);
});

// 规则集链接可达性
const urls = rules.filter((r) => r.type === "RULE-SET" && /^https?:/.test(r.parts[1]))
  .map((r) => ({ url: r.parts[1], no: r.no }));

(async () => {
  console.log(`分组 ${groups.length} 个 / 规则 ${rules.length} 条 / 远程规则集 ${urls.length} 个`);
  let bad = 0;
  for (const u of urls) {
    let code = 0, size = 0;
    try {
      const res = await fetch(u.url);
      code = res.status;
      if (res.ok) size = (await res.text()).split(/\r?\n/).filter((x) => x && !x.startsWith("#")).length;
    } catch (e) { code = "ERR"; }
    const name = u.url.split("/").pop();
    if (code !== 200 || size === 0) { bad++; console.log(`  ✗ L${u.no} ${name} -> ${code} (${size} 条)`); }
    else console.log(`  ✓ ${name.padEnd(22)} ${String(size).padStart(5)} 条规则`);
  }
  console.log("");
  if (errs.length) { errs.forEach((e) => console.log("✗ " + e)); }
  const total = errs.length + bad;
  console.log(total ? `结果: ${total} 项问题` : "结果: 全部通过");
  process.exit(total ? 1 : 0);
})();
