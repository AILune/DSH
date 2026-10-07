/**
 * 用真实 yaml 解析器校验 bundle patch 与 profile patch。
 * DSH 的 Include 用 yaml.load(content, { schema: entryListSchema }) 解析。
 */
const fs = require("fs");
const yaml = require("js-yaml");

const PROFILE = "C:\\Users\\85448\\.dsh\\profiles\\desktop";
const DEST = PROFILE + "\\node_modules\\dsh-plugin-lark-doc";

let fail = 0;

function checkYaml(label, file) {
  const bytes = fs.readFileSync(file);
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let doc;
  try {
    doc = yaml.load(bytes.toString("utf8"));
  } catch (e) {
    console.log(`  ❌ ${label}: YAML 解析失败 — ${e.message}`);
    fail++;
    return;
  }
  if (!Array.isArray(doc)) {
    console.log(`  ❌ ${label}: 顶层不是数组`);
    fail++;
    return;
  }
  console.log(`  ✅ ${label}  条目=${doc.length}  BOM=${hasBom}`);
  return doc;
}

console.log("=== bundle patch ===");
const bundleDoc = checkYaml("dsh-plugin-lark-doc/cordis.patch.yml", DEST + "\\cordis.patch.yml");
if (bundleDoc) {
  const rows = bundleDoc[0]?.insert;
  console.log("     insert 行数:", Array.isArray(rows) ? rows.length : "(不是数组!)");
  if (Array.isArray(rows)) {
    for (const r of rows) {
      console.log("       id   =", JSON.stringify(r.id));
      console.log("       name =", JSON.stringify(r.name));
      console.log("       config =", JSON.stringify(r.config));
    }
    const ok = rows.length === 1 && rows[0].name === "dsh-plugin-lark-doc" && rows[0].id === "lark-doc";
    console.log("     形状符合 applyEntryPatches:", ok ? "✅" : "❌");
    if (!ok) fail++;
  } else fail++;
}

console.log("\n=== profile patch（应已无 lark-doc 手工 mount）===");
const profileDoc = checkYaml("profile/cordis.patch.yml", PROFILE + "\\cordis.patch.yml");
if (profileDoc) {
  console.log("     条目:", profileDoc.map((e) => e.insert ? `insert(${e.insert.map((x) => x.id)})` : e.id).join(", "));
  const hasManual = JSON.stringify(profileDoc).includes("dsh-plugin-lark-doc");
  console.log("     仍含手工 mount:", hasManual ? "❌ 是（会重复挂载）" : "✅ 否");
  if (hasManual) fail++;
  const text = fs.readFileSync(PROFILE + "\\cordis.patch.yml", "utf8");
  console.log("     中文完好:", text.includes("实验室 DeepSeek") ? "✅" : "❌");
  if (!text.includes("实验室 DeepSeek")) fail++;
}

console.log("\n=== profile package.json ===");
try {
  const pm = JSON.parse(fs.readFileSync(PROFILE + "\\package.json", "utf8"));
  const hasDep = typeof pm.dependencies?.["dsh-plugin-lark-doc"] === "string";
  const hasBundle = pm.dsh?.profile?.bundles?.includes("dsh-plugin-lark-doc") === true;
  console.log("  ✅ JSON 合法");
  console.log("  dependencies 已声明:", hasDep ? "✅" : "❌");
  console.log("  bundles 已启用    :", hasBundle ? "✅" : "❌");
  if (!hasDep || !hasBundle) fail++;
} catch (e) {
  console.log("  ❌ package.json 非法:", e.message);
  fail++;
}

console.log(`\n${fail === 0 ? "✅ 全部通过 —— bundle 结构正确，无重复挂载" : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
