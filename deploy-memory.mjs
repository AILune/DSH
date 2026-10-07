/**
 * 部署 dsh-plugin-memory 到 profile：
 *  1. 备份 profile 的 package.json
 *  2. 把插件复制进 profile/node_modules/dsh-plugin-memory
 *  3. 在 profile package.json 登记依赖 + 启用 bundle
 *  4. 校验（编码、YAML、JSON、exports 可解析性）
 *
 * 注意：不做任何清理性删除。lark-doc 的 file: 依赖保持原样。
 */
import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_ROOT, resolveDshHome, resolveProfileDir, parseArgs } from "./dsh-paths.mjs";

const { profile, stamp } = parseArgs();
const PROFILE = resolveProfileDir({ profile });
const SRC = path.join(WORKSPACE_ROOT, "dsh-plugin-memory");
const NAME = "dsh-plugin-memory";

console.log("DSH home:", resolveDshHome());
console.log("profile :", PROFILE);
console.log("\n=== 1. 备份 profile/package.json ===");
const pmPath = path.join(PROFILE, "package.json");
const pmBefore = JSON.parse(fs.readFileSync(pmPath, "utf8"));
const bundlesBefore = [...(pmBefore.dsh?.profile?.bundles ?? [])];
// 全新机器上 profile 是空的（bundles 只有 base/web-app、没有任何插件依赖），
// 所以下面所有断言都必须基于「部署前的样子」，不能假设别的插件已经装好。
const depsBefore = { ...(pmBefore.dependencies ?? {}) };
const bak = `${pmPath}.pre-${NAME}-${stamp}`;
fs.copyFileSync(pmPath, bak);
console.log("  ->", path.basename(bak));
console.log("  部署前 bundles:", JSON.stringify(bundlesBefore));

console.log("\n=== 2. 复制插件到 profile/node_modules ===");
const dest = path.join(PROFILE, "node_modules", NAME);
const files = ["package.json", "cordis.patch.yml", path.join("lib", "index.js"), path.join("locale", "en.json"), path.join("locale", "zh.json")];
for (const rel of files) {
  const to = path.join(dest, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(SRC, rel), to);
  console.log(`  ${rel}  (${fs.statSync(to).size} B)`);
}

console.log("\n=== 3. 登记依赖并启用 bundle ===");
const pm = JSON.parse(fs.readFileSync(pmPath, "utf8"));
pm.dependencies ??= {};
pm.dependencies[NAME] = `file:${path.join(PROFILE, "node_modules", NAME).replace(/\\/g, "/")}`;
pm.dsh ??= {};
pm.dsh.profile ??= {};
pm.dsh.profile.bundles ??= [];
if (!pm.dsh.profile.bundles.includes(NAME)) pm.dsh.profile.bundles.push(NAME);
fs.writeFileSync(pmPath, JSON.stringify(pm, null, 2) + "\n", "utf8");
console.log("  dependencies:", JSON.stringify(pm.dependencies));
console.log("  bundles     :", JSON.stringify(pm.dsh.profile.bundles));

console.log("\n=== 4. 校验 ===");
let fail = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}`);
  if (detail !== undefined) console.log(`       ${detail}`);
  if (!ok) fail++;
};

const pkg = JSON.parse(fs.readFileSync(path.join(dest, "package.json"), "utf8"));
check("插件声明 dsh.bundle.patch", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");
check("无 dependencies（零第三方依赖）", Object.keys(pkg.dependencies ?? {}).length === 0, JSON.stringify(pkg.dependencies ?? {}));
check("peerDependencies 保留", Object.keys(pkg.peerDependencies ?? {}).length === 4, JSON.stringify(Object.keys(pkg.peerDependencies ?? {})));
check("exports 暴露 locale", typeof pkg.exports["./locale/*.json"] === "string");
check("exports 暴露 cordis.patch.yml", typeof pkg.exports["./cordis.patch.yml"] === "string");
check("无 locale 为空的包（en/zh 都在）", fs.existsSync(path.join(dest, "locale", "en.json")) && fs.existsSync(path.join(dest, "locale", "zh.json")));

// bundle patch YAML 形状
const patch = fs.readFileSync(path.join(dest, "cordis.patch.yml"), "utf8");
check("patch 含 insert", patch.includes("- insert:"));
check("patch 的 id 为 memory", /^\s*-\s*id:\s*memory\s*$/m.test(patch), patch.match(/id:\s*\S+/)?.[0]);
check("patch 的 name 为本包", patch.includes(`name: ${NAME}`));
check("patch 无 BOM", !(fs.readFileSync(path.join(dest, "cordis.patch.yml"))[0] === 0xef));

// profile package.json
const pmAfter = JSON.parse(fs.readFileSync(pmPath, "utf8"));
// 本脚本只写自己的依赖条目，其余条目必须一字未动。
// 旧版本在这里写死「lark-doc 依赖必须存在」——全新机器上它还没装，会误报失败。
const depsTouched = Object.entries(pmAfter.dependencies ?? {}).filter(([k, v]) => k !== NAME && depsBefore[k] !== v);
check(
  "未改动本插件以外的依赖条目",
  depsTouched.length === 0,
  depsTouched.length === 0
    ? `原有 ${Object.keys(depsBefore).length} 项原样保留${depsBefore["dsh-plugin-lark-doc"] === undefined ? "（lark-doc 本次部署前未安装）" : ""}`
    : JSON.stringify(depsTouched),
);
check("memory bundle 已启用", pmAfter.dsh.profile.bundles.includes(NAME), JSON.stringify(pmAfter.dsh.profile.bundles));
check("base/web-app 两个基础 bundle 保留", pmAfter.dsh.profile.bundles.includes("@deepseek-ai/dsh-base") && pmAfter.dsh.profile.bundles.includes("@deepseek-ai/dsh-web-app"));
// 与 lark-doc 的启用状态无关 —— 只断言「没移除任何原有条目」。
// 旧版本在这里写死「lark-doc 必须不在 bundles 中」，lark-doc 一被启用就会误报失败。
const bundlesAfter = pmAfter.dsh.profile.bundles;
const removedBundles = bundlesBefore.filter((b) => !bundlesAfter.includes(b));
check("未移除任何原有 bundle 条目", removedBundles.length === 0, `移除: ${JSON.stringify(removedBundles)}`);
check("profile patch 未被本次改动", fs.readFileSync(path.join(PROFILE, "cordis.patch.yml"), "utf8").includes("实验室 DeepSeek"));

// exports 子路径解析
const { createRequire } = await import("node:module");
const req = createRequire(path.join(PROFILE, "package.json"));
for (const spec of [NAME, `${NAME}/locale/zh.json`, `${NAME}/package.json`, `${NAME}/cordis.patch.yml`]) {
  try {
    const p = req.resolve(spec);
    check(`可解析 ${spec}`, fs.existsSync(p));
  } catch (e) {
    check(`可解析 ${spec}`, false, e.code);
  }
}

console.log(`\n${fail === 0 ? "✅ 部署完成，全部校验通过" : `❌ ${fail} 项校验失败`}`);
console.log("\n重启 DSH 后生效。");
process.exit(fail === 0 ? 0 : 1);
