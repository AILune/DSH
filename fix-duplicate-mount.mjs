/**
 * 移除 profile 里对两个记忆插件的「直接挂载」条目。
 *
 * 背景：这两段直挂是早期误判「bundle 层不生效」时加的 workaround。
 * 它位于组装顺序的最后一层（bundles → cordis.patch.yml → overlays），后写层获胜，
 * 因此即使 GUI 开关把包从 dsh.profile.bundles 移除，插件仍被它挂载 → 开关失效。
 *
 * 两个插件自带的 cordis.patch.yml 已包含完全同构的挂载条目与 config，
 * 所以删掉这里不会损失任何配置。
 *
 * 安全策略（fail-closed）：
 *  - 先备份
 *  - 逐行断言：要删的区间内容必须与预期完全一致，否则拒绝写入
 *  - 用真实 js-yaml 解析，断言条目数 9 → 7，且新数组 === 原数组过滤掉这两个条目（深度比对）
 *  - 断言新内容里不再出现这两个包名
 * 任何一条不通过 → 不写盘，退出码非 0
 */
import fs from "node:fs";
import path from "node:path";

const jsYaml = await import(
  "file:///D:/%E6%96%87%E6%A1%A3/deepseek-harness/default-workspace/yaml-check/node_modules/js-yaml/dist/js-yaml.cjs.js"
);
const yaml = jsYaml.default ?? jsYaml;

const PROFILE = "C:\\Users\\85448\\.dsh\\profiles\\desktop\\cordis.patch.yml";
const MARK_A = "dsh-plugin-memory";
const MARK_B = "dsh-plugin-working-memory";

const fail = (msg) => {
  console.error(`❌ 校验失败，未写入：${msg}`);
  process.exit(1);
};

// ---- 0. 路径核查 ----
const resolved = path.resolve(PROFILE);
if (resolved !== PROFILE) fail(`路径未按预期解析：${resolved}`);
if (!fs.existsSync(PROFILE)) fail(`目标文件不存在：${PROFILE}`);

const original = fs.readFileSync(PROFILE, "utf8");
const eol = original.includes("\r\n") ? "\r\n" : "\n";
const lines = original.split(/\r?\n/);

// ---- 1. 定位区间 ----
const startIdx = lines.findIndex((l) => /^\s*#\s*跨会话记忆插件/.test(l));
if (startIdx === -1) fail("找不到起始注释「# 跨会话记忆插件」");
const endIdx = lines.findIndex((l, i) => i > startIdx && /^\s+maxItems:\s*8\s*$/.test(l));
if (endIdx === -1) fail("找不到结束标记「maxItems: 8」");
if (lines.findIndex((l, i) => i > endIdx && /^\s+maxItems:\s*8\s*$/.test(l)) !== -1)
  fail("「maxItems: 8」出现多次，区间不唯一");

const removed = lines.slice(startIdx, endIdx + 1);

// ---- 2. 断言被删区间的内容确实就是那两段直挂 ----
const expectTokens = [
  "# 跨会话记忆插件",
  MARK_A,
  "# 工作记忆插件",
  MARK_B,
  "- insert:",
  "id: memory",
  "id: working-memory",
];
const removedText = removed.join("\n");
for (const t of expectTokens) {
  if (!removedText.includes(t)) fail(`被删区间缺少预期内容：${t}`);
}
const insertCount = removed.filter((l) => /^\s*- insert:\s*$/.test(l)).length;
if (insertCount !== 2) fail(`被删区间应恰好含 2 个 "- insert:"，实际 ${insertCount}`);
// 区间内不得夹带其它插件条目
const strayNames = removed.filter((l) => /^\s+name:\s+/.test(l)).map((l) => l.trim());
if (strayNames.length !== 2 || !strayNames.some((s) => s.includes(MARK_A)) || !strayNames.some((s) => s.includes(MARK_B)))
  fail(`被删区间内的 name 行意外：${JSON.stringify(strayNames)}`);

console.log("=== 将要删除的行（含行号）===");
removed.forEach((l, i) => console.log(`  ${startIdx + 1 + i}: ${l}`));

// ---- 3. 构造新内容 ----
const next = [...lines.slice(0, startIdx), ...lines.slice(endIdx + 1)];
// 收尾：若接缝处出现连续空行则收敛为一个
for (let i = next.length - 1; i > 0; i--) {
  if (next[i].trim() === "" && next[i - 1].trim() === "") next.splice(i, 1);
}
const nextText = next.join(eol);

// ---- 4. fail-closed 校验 ----
if (nextText.includes(MARK_A) || nextText.includes(MARK_B))
  fail("新内容里仍然出现插件包名");

let before, after;
try {
  before = yaml.load(original);
  after = yaml.load(nextText);
} catch (error) {
  fail(`YAML 解析失败：${error.message}`);
}
if (!Array.isArray(before) || !Array.isArray(after)) fail("顶层不是数组");
if (before.length !== 9) fail(`修复前顶层条目数应为 9，实际 ${before.length}`);
if (after.length !== 7) fail(`修复后顶层条目数应为 7，实际 ${after.length}`);

const strip = (arr) =>
  arr.filter((e) => {
    const s = JSON.stringify(e);
    return !s.includes(MARK_A) && !s.includes(MARK_B);
  });
const expected = strip(before);
if (JSON.stringify(expected) !== JSON.stringify(after))
  fail("新数组与「原数组剔除这两个条目」不相等 —— 可能误删或改动了他内容");

console.log(`\n=== YAML 校验通过 ===`);
console.log(`  顶层条目：${before.length} → ${after.length}`);
console.log(`  其余条目逐条深度比对：一致`);
console.log(`  剩余条目 id：${after.map((e) => e?.id ?? (e?.insert ? `insert(${e.insert.map((x) => x.id).join(",")})` : "?")).join(", ")}`);

// ---- 5. 备份并写入 ----
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const backup = `${PROFILE}.pre-dupmount-${stamp}`;
if (fs.existsSync(backup)) fail(`备份文件已存在：${backup}`);
fs.copyFileSync(PROFILE, backup);
console.log(`\n  备份：${backup}`);

fs.writeFileSync(PROFILE, nextText, "utf8");
const verify = yaml.load(fs.readFileSync(PROFILE, "utf8"));
if (!Array.isArray(verify) || verify.length !== 7) fail("写盘后回读校验失败");
console.log(`  已写入：${PROFILE}`);
console.log(`  写盘后回读：${verify.length} 个顶层条目 ✅`);

// ---- 6. 顺手修正两个插件自带 patch 里那句错误注释 ----
const fixes = [
  [
    "D:\\文档\\deepseek-harness\\default-workspace\\dsh-plugin-memory\\cordis.patch.yml",
    /# profile 的 cordis\.patch\.yml 可继续按 id: memory 覆盖这里 config 的任意字段[\s\S]*?# （后写的层获胜），所以注入上限、镜像路径等参数仍由用户决定。/,
    [
      "# 本文件是唯一的挂载来源：profile 通过 dsh.profile.bundles 引入本包，",
      "# bundle 层读出这里并挂载。GUI 的插件开关改的就是 dsh.profile.bundles，因此开关有效。",
      "# 若要在 profile 里覆盖本文件 config 的某个字段，可另加一条同 id（memory）的条目 ——",
      "# 组装顺序是 bundles → cordis.patch.yml → overlays，后写的层获胜。",
    ].join("\n"),
  ],
  [
    "D:\\文档\\deepseek-harness\\default-workspace\\dsh-plugin-working-memory\\cordis.patch.yml",
    /# 注意：本机桌面客户端上 bundle 层实测未生效[\s\S]*?# 会按 id 折叠，不会重复挂载。/,
    [
      "# 本文件是唯一的挂载来源：profile 通过 dsh.profile.bundles 引入本包，",
      "# bundle 层读出这里并挂载。GUI 的插件开关改的就是 dsh.profile.bundles，因此开关有效。",
      "# 若要在 profile 里覆盖本文件 config 的某个字段，可另加一条同 id（working-memory）的条目 ——",
      "# 组装顺序是 bundles → cordis.patch.yml → overlays，后写的层获胜。",
    ].join("\n"),
  ],
];
console.log("\n=== 修正插件自带 patch 里的错误注释 ===");
for (const [file, re, replacement] of fixes) {
  if (!fs.existsSync(file)) {
    console.log(`  ⚠️ 跳过（不存在）：${file}`);
    continue;
  }
  const src = fs.readFileSync(file, "utf8");
  if (!re.test(src)) {
    console.log(`  ⚠️ 跳过（未匹配到旧注释，可能已改过）：${path.basename(path.dirname(file))}`);
    continue;
  }
  const out = src.replace(re, replacement);
  yaml.load(out); // 语法校验
  fs.writeFileSync(file, out, "utf8");
  console.log(`  ✅ 已更新：${path.basename(path.dirname(file))}\\cordis.patch.yml`);
}

console.log("\n✅ 修复完成。重启 DSH 后：两个插件应停止工作（因为 bundle 层里没有它们）。");
