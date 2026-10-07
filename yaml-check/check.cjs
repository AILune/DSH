const fs = require("fs");
const yaml = require("js-yaml");

const profile = "C:\\Users\\85448\\.dsh\\profiles\\desktop\\cordis.patch.yml";

let doc;
try {
  doc = yaml.load(fs.readFileSync(profile, "utf8"));
} catch (error) {
  console.log("  ❌ YAML 语法无效:", error.message);
  process.exit(1);
}

console.log("  ✅ YAML 语法有效");
console.log("  顶层条目数:", Array.isArray(doc) ? doc.length : "(不是数组!)");

if (!Array.isArray(doc)) {
  console.log("  ❌ 顶层必须是数组");
  process.exit(1);
}

doc.forEach((entry, index) => {
  if (entry && entry.insert) {
    const ids = entry.insert.map((x) => x.id ?? x.name);
    console.log(`  [${index}] insert -> ${JSON.stringify(ids)}`);
  } else {
    console.log(`  [${index}] id=${entry?.id}  name=${entry?.name}`);
  }
});

const last = doc[doc.length - 1];
console.log("\n  === 新增条目 ===");
if (last && last.insert && Array.isArray(last.insert)) {
  const row = last.insert[0];
  console.log("    insert 是数组      :", Array.isArray(last.insert));
  console.log("    insert 长度        :", last.insert.length);
  console.log("    row.id             :", JSON.stringify(row.id));
  console.log("    row.name           :", JSON.stringify(row.name));
  console.log("    row.config         :", JSON.stringify(row.config));
  console.log("    row.config.timeoutMs:", typeof row.config?.timeoutMs, row.config?.timeoutMs);
  console.log("    row.config.identity :", typeof row.config?.identity, JSON.stringify(row.config?.identity));
} else {
  console.log("    ❌ 最后一个条目不是预期的 insert 形状");
  console.log("    ", JSON.stringify(last));
  process.exit(1);
}

// 同时确认新条目能被 applyEntryPatches 的语义正确识别
const insert = last.insert;
const okShape =
  insert.length === 1 &&
  typeof insert[0].id === "string" &&
  typeof insert[0].name === "string";
console.log("\n  形状符合 applyEntryPatches 预期:", okShape ? "✅ 是" : "❌ 否");
process.exit(okShape ? 0 : 1);
