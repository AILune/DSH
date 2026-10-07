/**
 * 端到端实测：真正调用插件工具的 execute()，验证 spawn lark-cli + JSON 解析链路。
 */
import { pathToFileURL } from "node:url";

const DOC_ID = "XftJda4MVo3qsvxdusIcaUDMn4F";

const registered = new Map();
const fakeCtx = {
  tools: { register: (tool) => registered.set(tool.name, tool) },
  logger: { info: () => {}, warn: () => {} },
};

const mod = await import(
  pathToFileURL(
    "D:/文档/deepseek-harness/default-workspace/dsh-plugin-lark-doc/lib/index.js",
  ).href,
);
mod.apply(fakeCtx, {});

const fakeExec = { signal: undefined };

function show(label, value) {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(value, null, 2).slice(0, 900));
}

// ① 读取 —— 应该读到我们之前建的测试文档
console.log("=== ① lark_doc_read 实测 ===");
try {
  const tool = registered.get("lark_doc_read");
  const value = await tool.execute({ doc: DOC_ID, doc_format: "markdown" }, fakeExec);
  show("返回的 value 对象", value);
  console.log("\n  render 输出:");
  for (const block of tool.output.render({ doc: DOC_ID }, value)) {
    console.log("   ", block.text.split("\n").slice(0, 6).join("\n    "));
  }
  console.log("\n  ✅ 读取成功");
} catch (error) {
  console.error("  ❌ 失败:", error.message);
}

// ② 替换 —— 真实写入
console.log("\n\n=== ② lark_doc_replace 实测（真实写入）===");
try {
  const tool = registered.get("lark_doc_replace");
  const value = await tool.execute(
    {
      doc: DOC_ID,
      pattern: "MARKER-A2：此段落由 DSH 编辑写入，update 能力验证通过。",
      content: "MARKER-PLUGIN：此段落由 DSH 插件工具写入，验证插件链路通过。",
    },
    fakeExec,
  );
  show("返回的 value 对象", value);
  console.log("\n  ✅ 替换成功");
} catch (error) {
  console.error("  ❌ 失败:", error.message);
}

// ③ 错误处理 —— 故意传错 token，验证错误信息可读
console.log("\n\n=== ③ 错误处理实测（故意传错 token）===");
try {
  const tool = registered.get("lark_doc_read");
  await tool.execute({ doc: "INVALID_TOKEN_XYZ" }, fakeExec);
  console.log("  ⚠️ 竟然成功了？不符合预期");
} catch (error) {
  console.log("  捕获到异常（预期内）:");
  console.log("   ", error.message.slice(0, 300));
  console.log("  ✅ 错误被正确抛出且信息可读");
}

// ④ 参数校验 —— 缺 required 字段
console.log("\n\n=== ④ 参数校验实测（缺 required 字段）===");
try {
  const tool = registered.get("lark_doc_read");
  await tool.execute({}, fakeExec);
  console.log("  ⚠️ 竟然通过了？不符合预期");
} catch (error) {
  console.log("  捕获到异常:", error.constructor.name);
  console.log("   ", error.message.slice(0, 250));
  console.log("  ✅ DSH 的 schema 校验拦住了");
}
