/**
 * 部署 dsh-plugin-lark-doc 到 profile：
 *  1. 备份 profile 的 package.json
 *  2. 把插件复制进 profile/node_modules/dsh-plugin-lark-doc
 *  3. 在 profile package.json 登记依赖 + 启用 bundle（唯一挂载动作）
 *  4. 校验（契约、编码、YAML、exports 可解析性、补丁层字节级不变）
 *
 * 为什么只改 bundles、绝不在 profile 的 cordis.patch.yml 里加直挂条目：
 * 组装顺序是 bundles → cordis.patch.yml → overlays，后写层获胜。
 * 之前正是为绕过被误判的「bundle 层不生效」而加了直挂条目，
 * 结果 GUI 插件开关彻底失效（关掉也还在跑）。这里把该教训写成断言。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { WORKSPACE_ROOT, resolveDshHome, resolveProfileDir, parseArgs, loadYaml } from "./dsh-paths.mjs";

const { profile, stamp } = parseArgs();
const PROFILE = resolveProfileDir({ profile });
const SRC = path.join(WORKSPACE_ROOT, "dsh-plugin-lark-doc");
const NAME = "dsh-plugin-lark-doc";
const ID = "lark-doc";

console.log("DSH home:", resolveDshHome());
console.log("profile :", PROFILE);

const yaml = loadYaml();
if (yaml === null) {
  console.error("❌ 找不到 js-yaml（应位于 yaml-check/node_modules/js-yaml）。请确认工作区完整。");
  process.exit(1);
}

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

const pmPath = path.join(PROFILE, "package.json");
const patchPath = path.join(PROFILE, "cordis.patch.yml");
const dest = path.join(PROFILE, "node_modules", NAME);

let fail = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}`);
  if (detail !== undefined) console.log(`       ${detail}`);
  if (!ok) fail++;
};

console.log("=== 1. 备份 profile/package.json ===");
const patchHashBefore = sha(patchPath);
const bundlesBefore = [...(JSON.parse(fs.readFileSync(pmPath, "utf8")).dsh?.profile?.bundles ?? [])];
const bak = `${pmPath}.pre-${NAME}-${stamp}`;
fs.copyFileSync(pmPath, bak);
console.log("  ->", path.basename(bak));
console.log("  部署前 bundles:", JSON.stringify(bundlesBefore));
console.log("  部署前补丁层 sha256:", patchHashBefore.slice(0, 16) + "…");

console.log("\n=== 2. 复制插件到 profile/node_modules ===");
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
pm.dependencies[NAME] = `file:${dest.replace(/\\/g, "/")}`;
pm.dsh ??= {};
pm.dsh.profile ??= {};
pm.dsh.profile.bundles ??= [];
if (!pm.dsh.profile.bundles.includes(NAME)) pm.dsh.profile.bundles.push(NAME);
fs.writeFileSync(pmPath, JSON.stringify(pm, null, 2) + "\n", "utf8");
console.log("  bundles:", JSON.stringify(pm.dsh.profile.bundles));

console.log("\n=== 4. 校验 ===");
check("源文件与部署副本一致（lib/index.js）", sha(path.join(SRC, "lib", "index.js")) === sha(path.join(dest, "lib", "index.js")));

const pkg = JSON.parse(fs.readFileSync(path.join(dest, "package.json"), "utf8"));
check("插件声明 dsh.bundle.patch", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");
check("无 dependencies（零第三方依赖）", Object.keys(pkg.dependencies ?? {}).length === 0, JSON.stringify(pkg.dependencies ?? {}));
check("无 peerDependencies（故不受版本兼容门禁约束）", Object.keys(pkg.peerDependencies ?? {}).length === 0, JSON.stringify(pkg.peerDependencies ?? {}));
check("exports 暴露 locale", typeof pkg.exports["./locale/*.json"] === "string");
check("exports 暴露 cordis.patch.yml", typeof pkg.exports["./cordis.patch.yml"] === "string");
check("en/zh locale 都在", fs.existsSync(path.join(dest, "locale", "en.json")) && fs.existsSync(path.join(dest, "locale", "zh.json")));
for (const loc of ["en", "zh"]) {
  let ok = true;
  let detail;
  try {
    JSON.parse(fs.readFileSync(path.join(dest, "locale", `${loc}.json`), "utf8"));
  } catch (e) {
    ok = false;
    detail = String(e);
  }
  check(`locale/${loc}.json 是合法 JSON`, ok, detail);
}

const patch = fs.readFileSync(path.join(dest, "cordis.patch.yml"), "utf8");
check("patch 含 insert", patch.includes("- insert:"));
check(`patch 的 id 为 ${ID}`, new RegExp(`^\\s*-\\s*id:\\s*${ID}\\s*$`, "m").test(patch), patch.match(/id:\s*\S+/)?.[0]);
check("patch 的 name 为本包", patch.includes(`name: ${NAME}`));
check("patch 恰好只有一个 insert 条目", (patch.match(/- insert:/g) ?? []).length === 1);
check("patch 无 BOM", fs.readFileSync(path.join(dest, "cordis.patch.yml"))[0] !== 0xef);

const pmAfter = JSON.parse(fs.readFileSync(pmPath, "utf8"));
check("lark-doc 已在 bundles 中（本次启用的目标）", pmAfter.dsh.profile.bundles.includes(NAME));
check("另外两个插件 bundle 保留", pmAfter.dsh.profile.bundles.includes("dsh-plugin-memory") && pmAfter.dsh.profile.bundles.includes("dsh-plugin-working-memory"));
check("base/web-app 两个基础 bundle 保留", pmAfter.dsh.profile.bundles.includes("@deepseek-ai/dsh-base") && pmAfter.dsh.profile.bundles.includes("@deepseek-ai/dsh-web-app"));
// 注意用 every 而不是 length===1：重跑时本插件已在 bundles 中，added 为空数组也应通过。
const added = pmAfter.dsh.profile.bundles.filter((b) => !bundlesBefore.includes(b));
const removed = bundlesBefore.filter((b) => !pmAfter.dsh.profile.bundles.includes(b));
check("bundle 列表只新增本插件、未移除任何条目", removed.length === 0 && added.every((a) => a === NAME), `added=${JSON.stringify(added)} removed=${JSON.stringify(removed)}`);

// 关键：补丁层必须字节级不变（防止重复挂载复发）
const patchHashAfter = sha(patchPath);
check("profile 补丁层字节级未变（无重复挂载风险）", patchHashAfter === patchHashBefore, `${patchHashBefore.slice(0, 16)}… vs ${patchHashAfter.slice(0, 16)}…`);
const patchText = fs.readFileSync(patchPath, "utf8");
check(`补丁层无 ${NAME} 直挂条目`, !patchText.includes(NAME));
check(`补丁层无 ${ID} 直挂条目`, !patchText.includes(ID));
check("补丁层无任何 insert 条目", !patchText.includes("- insert:"));
let yamlOk = true;
let yamlDetail;
try {
  const parsed = yaml.load(patchText);
  yamlOk = Array.isArray(parsed);
  yamlDetail = Array.isArray(parsed) ? `数组，${parsed.length} 个顶层条目` : `不是数组：${typeof parsed}`;
} catch (e) {
  yamlOk = false;
  yamlDetail = String(e);
}
check("补丁层仍是合法 YAML 数组", yamlOk, yamlDetail);

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
console.log("\n工具契约另由 lark-doc-test/test-tool-contract.mjs 用真实 dsh-tools 校验器验证（单独运行）。");
console.log("重启 DSH 后生效。");
process.exit(fail === 0 ? 0 : 1);
