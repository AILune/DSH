/**
 * 用真实 schemastery 校验插件 Config：
 *  - 空对象能拿到全部默认值（cordis 用 Config 的默认值填充缺失字段）
 *  - 补丁里写的那份 config 能通过校验
 *  - Config["~standard"] 存在（cordis 正是靠它决定是否校验）
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const HERE = "D:\\文档\\deepseek-harness\\default-workspace\\working-memory-test";
register(pathToFileURL(path.join(HERE, "mocks", "hooks-real.mjs")), import.meta.url);

const mod = await import(
  pathToFileURL("D:\\文档\\deepseek-harness\\default-workspace\\dsh-plugin-working-memory\\lib\\index.js").href
);

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}`);
  if (detail !== undefined) console.log(`       ${detail}`);
  ok ? (pass += 1) : (fail += 1);
};

console.log("=== 真实 schemastery 下的 Config ===");
check("Config 可调用", typeof mod.Config === "function", typeof mod.Config);
check('Config["~standard"] 存在（cordis 会校验）', mod.Config["~standard"] !== undefined);

console.log("\n=== 空对象 → 默认值 ===");
const empty = mod.Config({});
console.log("  ", JSON.stringify(empty));
check("entryFile 默认 .dsh/WORKING.md", empty.entryFile === ".dsh/WORKING.md", empty.entryFile);
check("stateDir 默认 .dsh/work", empty.stateDir === ".dsh/work", empty.stateDir);
check("maxDetailChars 默认 4000", empty.maxDetailChars === 4000, empty.maxDetailChars);
check("maxItems 默认 8", empty.maxItems === 8, empty.maxItems);

console.log("\n=== 补丁里的 config 能通过校验 ===");
const patchCfg = {
  entryFile: ".dsh/WORKING.md",
  stateDir: ".dsh/work",
  maxDetailChars: 4000,
  maxItems: 8,
};
let ok = true;
let detail = "";
try {
  const out = mod.Config(patchCfg);
  detail = JSON.stringify(out);
  ok = out.entryFile === ".dsh/WORKING.md";
} catch (e) {
  ok = false;
  detail = String(e);
}
check("补丁 config 通过 Config()", ok, detail);

console.log("\n=== ~standard.validate 也能通过（cordis 走的就是这条路）===");
let ok2 = true;
let detail2 = "";
try {
  const res = mod.Config["~standard"].validate(patchCfg);
  detail2 = JSON.stringify(res);
  ok2 = res.issues === undefined || res.issues === null;
} catch (e) {
  ok2 = false;
  detail2 = String(e);
}
check("~standard.validate 无 issue", ok2, detail2);

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败"} —— 通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
