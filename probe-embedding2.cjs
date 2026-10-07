/**
 * 确认 xdcyber 是"没权限"还是"根本没有 embedding 模型"。
 * 同时试探测网关的模型清单粒度（new-api 可能有 /api/models 或 models 带 ?type）。
 */
const fs = require("node:fs");
const BASE = "http://pubip.xdcyber.cn:6008/v1";

function findKey() {
  if (process.env.XDCYBER_API_KEY) return process.env.XDCYBER_API_KEY;
  const t = fs.readFileSync("C:\\Users\\85448\\.dsh\\.credentials.yaml", "utf8");
  const m = t.match(/XDCYBER_API_KEY\s*:\s*([^\s,}\]]+)/);
  return m ? m[1].replace(/['"]/g, "") : null;
}
const KEY = findKey();
const H = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function tryEmbedding(model) {
  const res = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ model, input: "test" }),
  });
  const t = await res.text();
  let msg = t.slice(0, 160);
  try {
    const j = JSON.parse(t);
    msg = j.error?.message ?? JSON.stringify(j).slice(0, 160);
  } catch {}
  console.log(`  ${String(res.status).padEnd(4)} ${model.padEnd(34)} ${msg}`);
}

(async () => {
  console.log("=== 逐一试常见 embedding 模型名 ===");
  const models = [
    "text-embedding-ada-002", "text-embedding-3-small", "text-embedding-3-large",
    "bge-large-zh", "bge-m3", "bge-small-zh-v1.5", "m3e-base",
    "text-embedding-v1", "text-embedding-v2", "text-embedding-v3",
    "embedding-2", "embedding-3", "jina-embeddings-v2-base-zh",
    "voyage-3", "nomic-embed-text", "deepseek-embedding",
  ];
  for (const m of models) await tryEmbedding(m);

  console.log("\n=== 网关模型清单的完整原始输出（看是否分页/有别的字段）===");
  const r = await fetch(`${BASE}/models`, { headers: H });
  const j = await r.json();
  console.log("  模型数:", j.data?.length);
  for (const m of j.data ?? []) {
    console.log(`    ${m.id}  endpoint_types=${JSON.stringify(m.supported_endpoint_types)}  owned_by=${m.owned_by}`);
  }

  console.log("\n=== 试 new-api 常见的管理端点（看模型分组信息）===");
  for (const p of ["/api/models", "/api/status", "/api/models/embedding"]) {
    try {
      const res = await fetch(`http://pubip.xdcyber.cn:6008${p}`, { headers: H });
      const t = (await res.text()).slice(0, 200);
      console.log(`  ${String(res.status).padEnd(4)} ${p.padEnd(24)} ${t.replace(/\n/g," ")}`);
    } catch (e) {
      console.log(`  ERR  ${p}  ${e.message}`);
    }
  }

  console.log("\n=== 结论判定 ===");
  console.log("  若所有 embedding 模型都是 403 'no access' → 网关侧未给该 token 开通 embedding（可能管理员能开）");
  console.log("  若出现 404 / 'model not found'        → 网关根本没有 embedding 模型");
  console.log("  若出现 500 'not implemented'          → 该模型存在但不支持 embeddings 端点");
})();
