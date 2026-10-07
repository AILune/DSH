/**
 * 解析 app.asar 头：用 UInt32 读 pickle 长度，逐字节扫描找 JSON 的真实结尾。
 * 目标：拿到 asar 索引，从而读取应用 package.json，并确认能否从 asar 内
 * 提取 commander/semver 以便跑 dsh --dump-config。
 */
import fs from "node:fs";

const ASAR = "D:\\DSH\\resources\\app.asar";
const fd = fs.openSync(ASAR, "r");
const fileSize = fs.fstatSync(fd).size;
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);

const pickleLen = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(8);
const jsonStart = 8 + pickleLen;

console.log("=== asar 头 ===");
console.log("  文件总大小 :", fileSize);
console.log("  pickleLen  :", pickleLen);
console.log("  jsonLen    :", jsonLen);
console.log("  jsonStart  :", jsonStart);
console.log("  jsonStart+16 =", jsonStart + 16, "（16 字节对齐检验）");

// 读一段候选并把真实结尾找出来
const raw = Buffer.alloc(Math.min(jsonLen + 4096, fileSize - jsonStart));
fs.readSync(fd, raw, 0, raw.length, jsonStart);
fs.closeSync(fd);

/** 扫描出第一个完整 JSON 对象的结束位置（括号配平，考虑字符串与转义） */
function jsonEnd(buf) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === 0x5c) esc = true;
      else if (c === 0x22) inStr = false;
      continue;
    }
    if (c === 0x22) inStr = true;
    else if (c === 0x7b || c === 0x5b) depth++;
    else if (c === 0x7d || c === 0x5d) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

const end = jsonEnd(raw);
console.log("\n  括号配平找到的 JSON 结尾:", end, end > 0 ? `（长度 ${end}，与 jsonLen 差 ${jsonLen - end}）` : "");

const index = JSON.parse(raw.slice(0, end).toString("utf8"));
console.log("  ✅ 索引解析成功");

console.log("\n=== asar 顶层条目 ===");
for (const [k, v] of Object.entries(index.files)) {
  const size = v.size !== undefined ? ` (${v.size} B)` : "";
  console.log(`  ${v.files ? "[dir] " : "[file]"} ${k}${size}`);
}

function find(parts) {
  let cur = index;
  for (const p of parts) {
    if (!cur.files || !cur.files[p]) return undefined;
    cur = cur.files[p];
  }
  return cur;
}
function readAsar(entry) {
  const f = fs.openSync(ASAR, "r");
  const b = Buffer.alloc(entry.size);
  fs.readSync(f, b, 0, entry.size, jsonStart + Number(entry.offset));
  fs.closeSync(f);
  return b.toString("utf8");
}

console.log("\n=== 应用 package.json ===");
const e = find(["package.json"]);
if (e) {
  const pkg = JSON.parse(readAsar(e));
  console.log("  name    :", pkg.name);
  console.log("  version :", pkg.version);
  console.log("  main    :", pkg.main);
  console.log("  dependencies:", JSON.stringify(pkg.dependencies ?? {}));
} else console.log("  ❌ 未找到");

console.log("\n=== asar 内 node_modules 关键包 ===");
const nm = find(["node_modules"]);
if (nm?.files) {
  const names = Object.keys(nm.files);
  console.log("  顶层条目数:", names.length);
  const want = ["dsh", "commander", "semver", "js-yaml", "@deepseek-ai", "cordis"];
  for (const w of want) console.log(`    ${names.includes(w) ? "✅" : "❌"} ${w}`);
  const ds = nm.files["@deepseek-ai"];
  if (ds?.files) {
    const pkgs = Object.keys(ds.files);
    console.log("  @deepseek-ai 下包数:", pkgs.length);
    console.log("  含 dsh:", pkgs.includes("dsh"), " 含 dsh-app-boot:", pkgs.includes("dsh-app-boot"));
    console.log("  含 dsh-base:", pkgs.includes("dsh-base"), " 含 dsh-web-app:", pkgs.includes("dsh-web-app"));
  }
} else console.log("  ❌ asar 内没有 node_modules");
