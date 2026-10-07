/**
 * 验证 exports 子路径解析 —— UI 能否拿到插件标题取决于此。
 */
const { createRequire } = require("node:module");
const fs = require("node:fs");

const profileDir = "C:/Users/85448/.dsh/profiles/desktop";
const req = createRequire(profileDir + "/package.json");
const NAME = "dsh-plugin-lark-doc";

const specs = [
  NAME,
  `${NAME}/package.json`,
  `${NAME}/cordis.patch.yml`,
  `${NAME}/locale/en.json`,
  `${NAME}/locale/zh.json`,
];

let fail = 0;
console.log("=== exports 子路径解析 ===");
for (const s of specs) {
  try {
    const p = req.resolve(s);
    console.log(`  ✅ ${s}`);
    console.log(`       -> ${p}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${s}  (${e.code})`);
  }
}

console.log("\n=== 模拟 DSH readPluginMeta 的读取流程 ===");
function optionalResourcePath(spec) {
  try {
    return req.resolve(spec);
  } catch (e) {
    const missing = [
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
      "ERR_MODULE_NOT_FOUND",
      "MODULE_NOT_FOUND",
      "ENOENT",
      "ENOTDIR",
    ].includes(e.code);
    if (missing) return undefined;
    throw e;
  }
}

const englishPath = optionalResourcePath(`${NAME}/locale/en.json`);
const manifestPath = optionalResourcePath(`${NAME}/package.json`);
console.log("  englishPath :", englishPath ?? "(undefined → meta 会缺失！)");
console.log("  manifestPath:", manifestPath ?? "(undefined)");

let title, description;
if (englishPath) {
  const dict = JSON.parse(fs.readFileSync(englishPath, "utf8"));
  title = dict.meta?.title;
  description = dict.meta?.description;
}
if (!title && manifestPath) {
  title = JSON.parse(fs.readFileSync(manifestPath, "utf8")).name;
}
console.log("\n  → 解析出的展示信息:");
console.log("      title      :", JSON.stringify(title));
console.log("      description:", JSON.stringify(description));

const metaResolves = englishPath !== undefined && title !== undefined;
console.log(
  "\n" +
    (metaResolves
      ? "✅ readPluginMeta 会返回有效 meta —— UI 能显示标题"
      : "❌ readPluginMeta 会返回 undefined —— UI 拿不到标题"),
);

// 顺带确认 zh.json 内容
const zh = JSON.parse(fs.readFileSync(req.resolve(`${NAME}/locale/zh.json`), "utf8"));
console.log("\n=== 中文 locale ===");
console.log("  title      :", zh.meta?.title);
console.log("  description:", zh.meta?.description);

process.exit(fail === 0 && metaResolves ? 0 : 1);
