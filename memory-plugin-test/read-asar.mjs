/**
 * 解析 app.asar 头部（格式：4B pickle 长度 + 4B json 长度 + 4B json 长度 + JSON），
 * 提取其中的 package.json / 配置，确认桌面客户端的启动方式。
 */
import fs from "node:fs";

const ASAR = "D:\\DSH\\resources\\app.asar";
const fd = fs.openSync(ASAR, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);

const pickleLen = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(8);
const jsonStart = 8 + pickleLen;
const buf = Buffer.alloc(jsonLen);
fs.readSync(fd, buf, 0, jsonLen, jsonStart);
fs.closeSync(fd);

console.log("=== 头部解析 ===");
console.log("  pickleLen =", pickleLen, " jsonLen =", jsonLen, " jsonStart =", jsonStart);
console.log("  JSON 开头 64 字节:", JSON.stringify(buf.slice(0, 64).toString("utf8")));

let index;
try {
  index = JSON.parse(buf.toString("utf8"));
  console.log("  ✅ JSON 一次解析成功");
} catch (e) {
  // 尾部有多余字节：按"最后一个 }"截断
  const s = buf.toString("utf8");
  const cut = s.lastIndexOf("}");
  console.log(`  jsonLen 偏大（报错: ${e.message.slice(0, 60)}），按最后一个 }} 截断到 ${cut + 1}`);
  index = JSON.parse(s.slice(0, cut + 1));
  console.log("  ✅ 截断后解析成功");
}
console.log("=== asar 顶层条目 ===");
for (const [k, v] of Object.entries(index.files)) {
  console.log(`  ${v.files ? "[dir] " : "[file]"} ${k}`);
}

/** 按路径取 asar 内文件的偏移与大小 */
function find(node, parts) {
  let cur = node;
  for (const p of parts) {
    if (!cur.files || !cur.files[p]) return undefined;
    cur = cur.files[p];
  }
  return cur;
}

/** 读取 asar 内某个文件 */
function readAsar(entry) {
  const f = fs.openSync(ASAR, "r");
  const b = Buffer.alloc(entry.size);
  fs.readSync(f, b, 0, entry.size, jsonStart + Number(entry.offset));
  fs.closeSync(f);
  return b.toString("utf8");
}

console.log("\n=== 应用 package.json ===");
try {
  const e = find(index, ["package.json"]);
  if (e) {
    const pkg = JSON.parse(readAsar(e));
    console.log("  name      :", pkg.name);
    console.log("  version   :", pkg.version);
    console.log("  main      :", pkg.main);
    console.log("  dependencies:", JSON.stringify(pkg.dependencies ?? {}, null, 2));
  } else console.log("  ❌ 未找到");
} catch (err) {
  console.log("  ❌", err.message);
}

console.log("\n=== 是否存在 dsh-base / dsh-app-boot（运行时是否在 asar 内）===");
const nm = find(index, ["node_modules"]);
if (nm?.files) {
  const names = Object.keys(nm.files);
  console.log("  asar 内 node_modules 顶层条目数:", names.length);
  console.log("  含 @deepseek-ai:", names.includes("@deepseek-ai"));
  const ds = nm.files["@deepseek-ai"];
  if (ds?.files) {
    const pkgs = Object.keys(ds.files);
    console.log("  @deepseek-ai 下包数:", pkgs.length);
    for (const want of ["dsh", "dsh-app-boot", "dsh-base", "dsh-web-app", "dsh-storage-domain", "cordis"]) {
      console.log(`    ${pkgs.includes(want) ? "✅" : "❌"} ${want}`);
    }
    console.log("  含 commander:", names.includes("commander"));
    console.log("  含 semver   :", names.includes("semver"));
    console.log("  含 js-yaml  :", names.includes("js-yaml"));
  }
} else {
  console.log("  ❌ asar 内没有 node_modules");
}
