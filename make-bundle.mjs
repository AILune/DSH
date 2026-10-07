/**
 * 把 dsh-plugin-lark-doc 从"只挂载、未声明"升级为真正的 DSH bundle。
 *
 * 要做的三件事：
 *  1. 插件包内加 dsh.bundle.patch 声明 + cordis.patch.yml + locale/en.json
 *  2. profile 的 package.json 把插件声明为 dependencies 并加入 dsh.profile.bundles
 *  3. 从 profile 的 cordis.patch.yml 里移除手工 mount（改由 bundle 挂载，避免重复）
 *
 * 全程 Node + UTF-8，不经过 PowerShell 的编码转换。
 */
import fs from "node:fs";
import path from "node:path";

const PROFILE = "C:\\Users\\85448\\.dsh\\profiles\\desktop";
const PLUGIN_SRC = "D:\\文档\\deepseek-harness\\default-workspace\\dsh-plugin-lark-doc";
const PLUGIN_NAME = "dsh-plugin-lark-doc";
const stamp = process.argv[2] ?? "backup";

// ---------------------------------------------------------------- 备份
console.log("=== 备份 ===");
for (const f of ["package.json", "cordis.patch.yml"]) {
  const src = path.join(PROFILE, f);
  const dst = `${src}.prebundle-${stamp}`;
  fs.copyFileSync(src, dst);
  console.log(`  ${f} -> ${path.basename(dst)}`);
}

// ---------------------------------------------- ① 插件包：补 bundle 声明
console.log("\n=== ① 插件包补 bundle 声明 ===");
const pluginManifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_SRC, "package.json"), "utf8"));
pluginManifest.dsh = { bundle: { patch: "./cordis.patch.yml" } };
fs.writeFileSync(
  path.join(PLUGIN_SRC, "package.json"),
  JSON.stringify(pluginManifest, null, 2) + "\n",
  "utf8",
);
console.log("  package.json 加入 dsh.bundle.patch");

const patchFile = `# dsh-plugin-lark-doc bundle patch: 把飞书文档工具注册进工具注册表。
#
# 与 dsh-experimental-voice-input-bundle 等官方 bundle 同构：一个 insert 挂载自身。
# profile 的 cordis.patch.yml 可继续按 id: lark-doc 覆盖这里的 config（后写的层获胜），
# 所以超时/身份等参数仍由用户的 profile 决定。

- insert:
    - id: lark-doc
      name: dsh-plugin-lark-doc
      config:
        timeoutMs: 120000
        identity: user
`;
fs.writeFileSync(path.join(PLUGIN_SRC, "cordis.patch.yml"), patchFile, "utf8");
console.log("  写入 cordis.patch.yml");

const localeDir = path.join(PLUGIN_SRC, "locale");
fs.mkdirSync(localeDir, { recursive: true });
fs.writeFileSync(
  path.join(localeDir, "en.json"),
  JSON.stringify(
    {
      meta: {
        title: "Feishu Docs",
        description:
          "Read and write Feishu (Lark) Docx documents through lark-cli: create, read, replace text, insert blocks, and search.",
      },
    },
    null,
    2,
  ) + "\n",
  "utf8",
);
console.log("  写入 locale/en.json");

// --------------------------------------- ② profile：声明依赖 + 启用 bundle
console.log("\n=== ② profile/package.json 声明依赖与 bundle ===");
const profileManifestPath = path.join(PROFILE, "package.json");
const profileManifest = JSON.parse(fs.readFileSync(profileManifestPath, "utf8"));

profileManifest.dependencies ??= {};
// 用 file: 绝对路径指向 profile 自身的 node_modules，避免 pnpm 重复安装
// （Node 解析与 DSH 的 resolveBundleDir 都以 profile 目录为第二锚点，
//  因此 profile/node_modules/<name> 这个位置本身就是可解析的）
profileManifest.dependencies[PLUGIN_NAME] =
  `file:${path.join(PROFILE, "node_modules", PLUGIN_NAME).replace(/\\/g, "/")}`;

profileManifest.dsh ??= {};
profileManifest.dsh.profile ??= {};
profileManifest.dsh.profile.bundles ??= [];
if (!profileManifest.dsh.profile.bundles.includes(PLUGIN_NAME)) {
  // 排在既有 bundle 之后：后写的层获胜
  profileManifest.dsh.profile.bundles.push(PLUGIN_NAME);
}

fs.writeFileSync(profileManifestPath, JSON.stringify(profileManifest, null, 2) + "\n", "utf8");
console.log("  dependencies:", JSON.stringify(profileManifest.dependencies[PLUGIN_NAME]));
console.log("  bundles     :", JSON.stringify(profileManifest.dsh.profile.bundles));

// ------------------------------- ③ profile patch：移除手工 mount（避免重复）
console.log("\n=== ③ 从 profile/cordis.patch.yml 移除手工 mount ===");
const profilePatchPath = path.join(PROFILE, "cordis.patch.yml");
let text = fs.readFileSync(profilePatchPath, "utf8").replace(/\r\n/g, "\n");
const marker = "\n- insert:\n    - id: lark-doc\n";
const at = text.indexOf(marker);
if (at === -1) {
  console.log("  ⚠️ 未找到手工 mount 块，跳过（可能已移除）");
} else {
  const removed = text.slice(at);
  text = text.slice(0, at).replace(/\n+$/, "\n");
  fs.writeFileSync(profilePatchPath, Buffer.from(text, "utf8"));
  console.log("  已移除以下内容:");
  console.log(removed.split("\n").map((l) => "      " + l).join("\n"));
}

// ---------------------------------------------------------------- 校验
console.log("\n=== 校验 ===");
const after = fs.readFileSync(profilePatchPath);
console.log("  profile patch 有 BOM:", after[0] === 0xef && after[1] === 0xbb && after[2] === 0xbf);
console.log("  profile patch 含中文:", after.toString("utf8").includes("实验室 DeepSeek"));
console.log("  profile patch 已无手工 mount:", !after.toString("utf8").includes("dsh-plugin-lark-doc"));

// 部署插件新文件到 profile/node_modules
console.log("\n=== 部署插件到 profile/node_modules ===");
const dest = path.join(PROFILE, "node_modules", PLUGIN_NAME);
for (const rel of ["package.json", "cordis.patch.yml", path.join("locale", "en.json"), path.join("lib", "index.js")]) {
  const from = path.join(PLUGIN_SRC, rel);
  const to = path.join(dest, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`  部署 ${rel}`);
}
console.log("\n✅ 完成");
