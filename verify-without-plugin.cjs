/**
 * 回答"关掉插件后还能不能读写飞书文档"：
 *
 * 关键区分：
 *  - 插件 = 把我调用 lark-cli 这件事包装成带 schema 的工具
 *  - lark-cli + 授权 = 真正具备读写能力的东西，独立于插件
 *
 * 所以关掉插件后：工具没了，但底层能力与授权是否还在？——实测。
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = "C:\\Users\\85448\\AppData\\Roaming\\npm\\node_modules\\@larksuite\\cli\\bin\\lark-cli.exe";

function run(argv) {
  return new Promise((resolve) => {
    const c = spawn(CLI, argv, { windowsHide: true });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d.toString("utf8")));
    c.stderr.on("data", (d) => (err += d.toString("utf8")));
    c.on("close", (code) => resolve({ code, out, err }));
    c.on("error", (e) => resolve({ code: -1, out: "", err: e.message }));
  });
}

(async () => {
  console.log("=== ① lark-cli 本身还在吗（插件之外）===");
  console.log("  可执行文件存在:", fs.existsSync(CLI) ? "✅" : "❌");

  console.log("\n=== ② 授权是否独立于插件 ===");
  const status = await run(["auth", "status", "--format", "json"]);
  const line = (status.out + status.err).split("\n").find((l) => l.includes("tokenStatus") || l.includes("identity") || l.includes("grantedAt"));
  console.log("  auth status 可查:", status.out.includes("{") ? "✅" : "⚠️");
  const tokenStatus = (status.out + status.err).match(/"tokenStatus"\s*:\s*"([^"]+)"/);
  const as = (status.out + status.err).match(/"defaultAs"\s*:\s*"([^"]+)"/);
  console.log("  tokenStatus:", tokenStatus ? tokenStatus[1] : "(未取到)");
  console.log("  defaultAs  :", as ? as[1] : "(未取到)");

  console.log("\n=== ③ 不经过插件，直接用 pwsh 调 lark-cli 读写文档 ===");
  // 新建一篇文档，证明"关掉插件后我仍能写"
  const tmp = path.join(os.tmpdir(), "no-plugin-probe.txt");
  fs.writeFileSync(tmp, "# 无插件测试\n\n这段内容由 DSH 在不使用插件的情况下写入。\n", "utf8");

  const created = await run([
    "docs", "+create",
    "--title", "无插件能力验证",
    "--content", "@" + tmp,
    "--doc-format", "markdown",
    "--parent-position", "my_library",
    "--as", "user",
  ]);
  let docId = null;
  try {
    const j = JSON.parse(created.out);
    docId = j.data?.document?.document_id;
    console.log("  创建文档:", j.ok ? "✅ 成功" : "❌ 失败", docId ?? "");
  } catch {
    console.log("  创建文档: ⚠️ 输出非 JSON");
    console.log("   ", (created.out + created.err).slice(0, 200));
  }

  if (docId) {
    const fetched = await run(["docs", "+fetch", "--doc", docId, "--doc-format", "markdown", "--as", "user"]);
    let content = "";
    try {
      const j = JSON.parse(fetched.out);
      content = j.data?.document?.content ?? j.data?.content ?? "";
    } catch {}
    console.log("  读回文档:", content.length > 0 ? "✅ 成功" : "❌ 失败");
    console.log("  内容片段:", JSON.stringify(content.slice(0, 90)));

    console.log("\n  清理这篇验证文档…");
    // 它是 my_library 里的普通 docx（非 wiki 节点），用 drive +delete
    const del = await run(["drive", "+delete", "--file-token", docId, "--type", "docx", "--as", "user", "--yes"]);
    console.log("  删除:", del.out.includes('"ok": true') ? "✅ 已清理" : "⚠️ 需手动清理 " + docId);
  }

  console.log("\n=== ④ 结论 ===");
  console.log("  lark-cli 与授权都在插件之外，独立存在。");
})();
