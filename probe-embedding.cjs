/**
 * 探测 xdcyber 网关是否提供 /v1/embeddings。
 * 安全约束：绝不打印密钥明文；只发只读探测请求。
 */
const fs = require("node:fs");
const path = require("node:path");

const BASE = "http://pubip.xdcyber.cn:6008/v1";

// ---- 取密钥（不打印） ----
function findKey() {
  if (process.env.XDCYBER_API_KEY) return { k: process.env.XDCYBER_API_KEY, from: "环境变量 XDCYBER_API_KEY" };
  const f = "C:\\Users\\85448\\.dsh\\.credentials.yaml";
  if (!fs.existsSync(f)) return null;
  const t = fs.readFileSync(f, "utf8");
  // 凭据是 YAML，形如  refs: { XDCYBER_API_KEY: <value> }
  let m = t.match(/XDCYBER_API_KEY\s*:\s*([^\s,}\]]+)/);
  if (m) return { k: m[1].replace(/['"]/g, ""), from: "凭据库 refs" };
  // 也可能整段 base64/密文，退而求其次：找任何像 key 的长串
  m = t.match(/(sk-[A-Za-z0-9_-]{8,})/);
  if (m) return { k: m[1], from: "凭据库内联 key" };
  return null;
}

function mask(k) {
  if (!k) return "(空)";
  return `${k.slice(0, 4)}${"*".repeat(Math.max(0, k.length - 8))}${k.slice(-4)}  (长度 ${k.length})`;
}

async function probe(url, init, label) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  console.log(`\n--- ${label}`);
  console.log(`    HTTP ${res.status} ${res.statusText}`);
  const s = typeof body === "string" ? body : JSON.stringify(body, null, 1);
  console.log("    " + s.slice(0, 700).replace(/\n/g, "\n    "));
  return { status: res.status, body };
}

(async () => {
  const found = findKey();
  if (!found) {
    console.log("❌ 未能取得 XDCYBER_API_KEY，无法探测。");
    console.log("   （这本身也是结论：密钥不在环境变量与凭据库的可读位置）");
    process.exit(0);
  }
  const KEY = found.k;
  console.log("=== 密钥来源 ===");
  console.log(`  ${found.from}  →  ${mask(KEY)}`);
  console.log(`\n=== 目标网关 ===\n  ${BASE}`);

  const H = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

  await probe(`${BASE}/models`, { headers: H }, "GET /v1/models （列模型，判断网关能力面）");

  await probe(
    `${BASE}/embeddings`,
    { method: "POST", headers: H, body: JSON.stringify({ model: "text-embedding-ada-002", input: "测试" }) },
    "POST /v1/embeddings （model=text-embedding-ada-002）",
  );

  await probe(
    `${BASE}/embeddings`,
    { method: "POST", headers: H, body: JSON.stringify({ model: "deepseek-v4-flash", input: "测试" }) },
    "POST /v1/embeddings （model=deepseek-v4-flash，试当前模型）",
  );

  await probe(
    `${BASE}/embeddings`,
    { method: "POST", headers: H, body: JSON.stringify({ input: "测试" }) },
    "POST /v1/embeddings （不指定 model）",
  );
})().catch((e) => {
  console.log("\n❌ 探测异常:", e.message);
});
