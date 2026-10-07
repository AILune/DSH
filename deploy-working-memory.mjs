/**
 * 部署 dsh-plugin-working-memory 到 profile：
 *  1. 备份 profile 的 package.json 与 cordis.patch.yml
 *  2. 复制插件进 profile/node_modules/dsh-plugin-working-memory
 *  3. 登记依赖 + 启用 bundle —— 这是唯一的挂载动作
 *  4. 确认 profile 补丁层没有被写入本插件（防重复挂载）
 *  5. 校验
 *
 * 【挂载机制】只走 bundle 层：profile 的 package.json 把本包列入 dsh.profile.bundles，
 * bundle 层再读本包自带的 cordis.patch.yml，从中得到 insert 条目与默认 config。
 *
 * 【为什么不再直挂 profile 补丁层】历史上这里曾直接往 profile 的 cordis.patch.yml 写 insert，
 * 理由是「bundle 层本机实测不生效」。那个判断是错的 —— 真实原因是工具的输出契约写错
 * （returns 而非 output:{schema,render}），apply() 抛错导致插件从未成功挂载过一次，
 * 于是被误归因给了 bundle 机制。
 *
 * 直挂的后果是重复挂载：组装顺序是 bundles → cordis.patch.yml → overlays，后写层获胜，
 * 因此 GUI 插件开关把包从 dsh.profile.bundles 移除后，插件仍被这条直挂挂着继续工作 ——
 * 开关形同虚设（2026-10-04 实测确认）。
 *
 * 幂等：重复运行不会重复登记；不再写入补丁层。不做任何清理性删除。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { WORKSPACE_ROOT, resolveDshHome, resolveProfileDir, parseArgs, loadYaml } from "./dsh-paths.mjs";

const { profile, stamp } = parseArgs();
const PROFILE = resolveProfileDir({ profile });
const SRC = path.join(WORKSPACE_ROOT, "dsh-plugin-working-memory");
const NAME = "dsh-plugin-working-memory";
const ID = "working-memory";
const OTHER = "dsh-plugin-memory";
const WS_PATCH = path.join(PROFILE, "cordis.patch.yml");

console.log("DSH home:", resolveDshHome());
console.log("profile :", PROFILE);

let fail = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}`);
  if (detail !== undefined) console.log(`       ${detail}`);
  if (!ok) fail += 1;
};

console.log("=== 1. 备份 ===");
const pmPath = path.join(PROFILE, "package.json");
fs.copyFileSync(pmPath, `${pmPath}.pre-${ID}-${stamp}`);
console.log("  ->", path.basename(`${pmPath}.pre-${ID}-${stamp}`));
fs.copyFileSync(WS_PATCH, `${WS_PATCH}.pre-${ID}-${stamp}`);
console.log("  ->", path.basename(`${WS_PATCH}.pre-${ID}-${stamp}`));

console.log("\n=== 2. 复制插件 ===");
const dest = path.join(PROFILE, "node_modules", NAME);
for (const rel of ["package.json", "cordis.patch.yml", path.join("lib", "index.js"), path.join("locale", "en.json"), path.join("locale", "zh.json")]) {
  const to = path.join(dest, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(SRC, rel), to);
  console.log(`  ${rel}  (${fs.statSync(to).size} B)`);
}

console.log("\n=== 3. 登记依赖 + 启用 bundle（唯一的挂载动作）===");
const pm = JSON.parse(fs.readFileSync(pmPath, "utf8"));
const bundlesBefore = [...(pm.dsh?.profile?.bundles ?? [])];
// 全新机器上别的插件可能还没装，断言必须基于「部署前的样子」。
const depsBefore = { ...(pm.dependencies ?? {}) };
pm.dependencies ??= {};
pm.dependencies[NAME] = `file:${path.join(PROFILE, "node_modules", NAME).replace(/\\/g, "/")}`;
pm.dsh ??= {};
pm.dsh.profile ??= {};
pm.dsh.profile.bundles ??= [];
if (!pm.dsh.profile.bundles.includes(NAME)) pm.dsh.profile.bundles.push(NAME);
fs.writeFileSync(pmPath, JSON.stringify(pm, null, 2) + "\n", "utf8");
console.log("  bundles:", JSON.stringify(pm.dsh.profile.bundles));

// 供第 5 节解析 YAML 用（路径相对本仓库根，随工作区移动）
const yaml = loadYaml();

console.log("\n=== 4. 确认 profile 补丁层未被写入本插件 ===");
// 本脚本刻意不改动 profile 补丁层：直挂会造成重复挂载，让 GUI 插件开关失效（见文件头说明）。
const patchText = fs.readFileSync(WS_PATCH, "utf8");
check(`补丁层无 ${NAME} 直挂条目`, !patchText.includes(NAME), "有 = 重复挂载，GUI 开关会失效");
check(`补丁层无 ${OTHER} 直挂条目`, !patchText.includes(OTHER), "另一插件同理");
check("补丁层仍是合法 YAML 数组", yaml === null || Array.isArray(yaml.load(patchText)), yaml === null ? "⚠️ 未找到 js-yaml，跳过" : `${(yaml.load(patchText) ?? []).length} 项`);

console.log("\n=== 5. 校验 ===");
const pkg = JSON.parse(fs.readFileSync(path.join(dest, "package.json"), "utf8"));
check("插件声明 dsh.bundle.patch", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");
check("无 dependencies", Object.keys(pkg.dependencies ?? {}).length === 0, JSON.stringify(pkg.dependencies ?? {}));
check("peerDependencies 保留 4 项", Object.keys(pkg.peerDependencies ?? {}).length === 4, Object.keys(pkg.peerDependencies ?? {}).join(", "));
check("exports 暴露 locale / patch / package.json", typeof pkg.exports["./locale/*.json"] === "string" && typeof pkg.exports["./cordis.patch.yml"] === "string");
check("en/zh locale 都在", fs.existsSync(path.join(dest, "locale", "en.json")) && fs.existsSync(path.join(dest, "locale", "zh.json")));

// 唯一挂载来源是「本包自带的 patch」，所以它必须完整正确
const ownPatchText = fs.readFileSync(path.join(dest, "cordis.patch.yml"), "utf8");
check("自带 patch 含 insert 条目", /^\s*-\s*insert:\s*$/m.test(ownPatchText));
if (yaml !== null) {
  let own;
  try {
    own = yaml.load(ownPatchText);
  } catch (e) {
    own = null;
    check("自带 patch 是合法 YAML", false, String(e));
  }
  if (own !== null) {
    const row = Array.isArray(own) ? own.flatMap((e) => e.insert ?? []).find((r) => r.id === ID) : undefined;
    check("自带 patch 的 id 正确", row?.id === ID, JSON.stringify(row?.id));
    check("自带 patch 的 name 正确", row?.name === NAME, JSON.stringify(row?.name));
    check("自带 patch 的 config 完整", row?.config?.stateDir === ".dsh/work" && row?.config?.maxItems === 8, JSON.stringify(row?.config));
  }
} else {
  check("找到 js-yaml 以便解析自带 patch", false, "yaml-check/node_modules/js-yaml");
}

check("profile 补丁层无 BOM", fs.readFileSync(WS_PATCH)[0] !== 0xef);
check("profile 补丁层原有中文 displayName 未损坏", patchText.includes("实验室 DeepSeek"));

const pmAfter = JSON.parse(fs.readFileSync(pmPath, "utf8"));
const bundlesAfter = pmAfter.dsh.profile.bundles;
const added = bundlesAfter.filter((b) => !bundlesBefore.includes(b));
const removed = bundlesBefore.filter((b) => !bundlesAfter.includes(b));
check("bundle 列表只新增本插件、未移除任何条目", removed.length === 0 && added.every((a) => a === NAME), `added=${JSON.stringify(added)} removed=${JSON.stringify(removed)}`);
check("本插件已启用", bundlesAfter.includes(NAME));
check("基础 bundle 保留", bundlesAfter.includes("@deepseek-ai/dsh-base") && bundlesAfter.includes("@deepseek-ai/dsh-web-app"));
const depsTouched = Object.entries(pmAfter.dependencies ?? {}).filter(([k, v]) => k !== NAME && depsBefore[k] !== v);
check(
  "未改动本插件以外的依赖条目",
  depsTouched.length === 0,
  depsTouched.length === 0
    ? `原有 ${Object.keys(depsBefore).length} 项原样保留${depsBefore["dsh-plugin-lark-doc"] === undefined ? "（lark-doc 本次部署前未安装）" : ""}`
    : JSON.stringify(depsTouched),
);

const req = createRequire(path.join(PROFILE, "package.json"));
for (const spec of [NAME, `${NAME}/locale/zh.json`, `${NAME}/package.json`]) {
  try {
    const p = req.resolve(spec);
    check(`可解析 ${spec}`, fs.existsSync(p));
  } catch (e) {
    check(`可解析 ${spec}`, false, e.code);
  }
}

console.log(`\n${fail === 0 ? "✅ 部署完成，全部校验通过" : `❌ ${fail} 项校验失败`}`);
console.log("\n挂载只经 bundle 层；GUI 插件开关（改 dsh.profile.bundles）热生效，无需重启。");
process.exit(fail === 0 ? 0 : 1);
