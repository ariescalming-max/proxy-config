// QuantumultX.conf 静态校验: 策略引用 / 正则 / 图标 / 规则集可达性
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "QuantumultX.conf");
const BUILTIN = ["direct", "proxy", "reject"];
const POLICY_KINDS = ["static", "url-latency-benchmark", "available", "round-robin", "dest-hash", "ssid"];

const lines = fs.readFileSync(FILE, "utf8").split(/\r?\n/);
let section = "";
const policies = [];   // {name, kind, members[], opts{}, no}
const filters = [];    // {url|builtin, policy, no}
const locals = [];     // {type, policy, no, raw}
lines.forEach((raw, i) => {
  const l = raw.trim();
  if (!l || l.startsWith("#") || l.startsWith(";")) return;
  const s = l.match(/^\[([a-z_]+)\]$/);
  if (s) { section = s[1]; return; }
  if (section === "policy") {
    const m = l.match(/^([a-z-]+)\s*=\s*(.+)$/);
    if (!m || !POLICY_KINDS.includes(m[1])) return;
    const parts = m[2].split(",").map((x) => x.trim());
    const p = { kind: m[1], name: parts[0], members: [], opts: {}, no: i + 1 };
    parts.slice(1).forEach((x) => {
      const kv = x.match(/^([a-z-]+)\s*=\s*(.*)$/);
      if (kv) p.opts[kv[1]] = kv[2]; else if (x) p.members.push(x);
    });
    policies.push(p);
  } else if (section === "filter_remote") {
    const parts = l.split(",").map((x) => x.trim());
    const fp = parts.find((x) => /^force-policy\s*=/.test(x));
    filters.push({ src: parts[0], policy: fp ? fp.split("=")[1].trim() : null, no: i + 1 });
  } else if (section === "filter_local") {
    const parts = l.split(",").map((x) => x.trim());
    locals.push({ type: parts[0], policy: parts[parts.length - 1], no: i + 1, raw: l });
  }
});

const errs = [];
const names = policies.map((p) => p.name);
const valid = names.concat(BUILTIN);
names.forEach((n, i) => { if (names.indexOf(n) !== i) errs.push(`策略重名: ${n}`); });
policies.forEach((p) => {
  p.members.forEach((m) => {
    if (!valid.includes(m)) errs.push(`L${p.no} 策略 ${p.name} 引用了不存在的成员: ${m}`);
    if (m === p.name) errs.push(`L${p.no} 策略 ${p.name} 自引用`);
  });
  if (!p.members.length && !p.opts["server-tag-regex"] && !p.opts["resource-tag-regex"])
    errs.push(`L${p.no} 策略 ${p.name} 既没成员也没 server-tag-regex`);
  const re = p.opts["server-tag-regex"];
  if (re) { try { new RegExp(re); } catch (e) { errs.push(`L${p.no} ${p.name} 正则非法: ${e.message}`); } }
  if (p.kind === "url-latency-benchmark" && p.opts.tolerance === "0")
    errs.push(`L${p.no} ${p.name} tolerance=0, 会频繁抖动切换`);
});
filters.forEach((f) => {
  if (f.policy && !valid.includes(f.policy)) errs.push(`L${f.no} 规则集目标不存在: ${f.policy}`);
  if (!/^(https?:\/\/|FILTER_)/.test(f.src)) errs.push(`L${f.no} 规则集来源看不懂: ${f.src}`);
});
const last = locals[locals.length - 1];
if (!last || last.type !== "final") errs.push("[filter_local] 最后一条不是 final");
locals.forEach((r, i) => {
  if (!valid.includes(r.policy)) errs.push(`L${r.no} 本地规则目标不存在: ${r.raw}`);
  if (r.type === "final" && i !== locals.length - 1) errs.push(`L${r.no} final 不在最后`);
});

async function head(url, tries = 2) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url);
      if (r.ok) return { code: r.status, size: (await r.text()).length };
      if (r.status !== 403) return { code: r.status, size: 0 };
    } catch (e) { /* retry */ }
    await new Promise((z) => setTimeout(z, 2500));
  }
  return { code: 403, size: 0 };
}

(async () => {
  console.log(`策略 ${policies.length} 个 / 远程规则集 ${filters.filter((f) => /^http/.test(f.src)).length} 个 / 本地规则 ${locals.length} 条`);
  const icons = [...new Set(policies.map((p) => p.opts["img-url"]).filter(Boolean))];
  let bad = 0, total = 0;
  for (const f of filters.filter((x) => /^http/.test(x.src))) {
    const r = await head(f.src);
    const n = f.src.split("/").pop();
    if (r.code !== 200 || !r.size) { bad++; console.log(`  ✗ 规则集 ${n} -> ${r.code}`); }
    else total += r.size.toString().length && (r.size, 0) || 0;
  }
  console.log(`  规则集: ${filters.filter((x) => /^http/.test(x.src)).length - bad} / ${filters.filter((x) => /^http/.test(x.src)).length} 可达`);
  let iconBad = 0;
  for (const u of icons) { const r = await head(u); if (r.code !== 200) { iconBad++; console.log(`  ✗ 图标 ${u.split("/").pop()} -> ${r.code}`); } }
  console.log(`  图标: ${icons.length - iconBad} / ${icons.length} 可达`);
  errs.forEach((e) => console.log("✗ " + e));
  const fail = errs.length + bad + iconBad;
  console.log(fail ? `\n结果: ${fail} 项问题` : "\n结果: 全部通过");
  process.exit(fail ? 1 : 0);
})();

