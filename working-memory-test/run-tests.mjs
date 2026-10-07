/**
 * dsh-plugin-working-memory 的行为测试。
 *
 * 做法：先用 module.register 注册加载钩子把 DSH 包重定向到 mock，
 * 再 import 插件，从而在不启动 DSH 的前提下执行插件的真实代码。
 * 工作区用临时目录，避免污染真实工作区。
 *
 * 运行：node run-tests.mjs
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HERE = "D:\\文档\\deepseek-harness\\default-workspace\\working-memory-test";
register(pathToFileURL(path.join(HERE, "mocks", "hooks.mjs")), import.meta.url);

const mod = await import(
  pathToFileURL("D:\\文档\\deepseek-harness\\default-workspace\\dsh-plugin-working-memory\\lib\\index.js").href
);

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "✅" : "❌"} ${label}`);
  if (detail !== undefined && detail !== "") console.log(`       ${detail}`);
  ok ? (pass += 1) : (fail += 1);
}

/* ------------------------------------------------------------ 测试用 ctx */

function makeCtx() {
  const tools = new Map();
  const handlers = new Map();
  const projections = new Map();
  const stateCells = new Map();

  return {
    logger: { warn: (...a) => console.log("      [warn]", ...a), info: () => {}, error: () => {} },
    sessionProjections: {
      register(def) {
        projections.set(def.key, def);
        stateCells.set(def.key, def.init());
      },
      stateOf(_session, key) {
        return stateCells.get(key);
      },
    },
    tools: {
      register(def) {
        tools.set(def.name, def);
        return () => tools.delete(def.name);
      },
    },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
      return () => {};
    },
    _tools: tools,
    _handlers: handlers,
    _projections: projections,
    _emitEvent(session, event) {
      for (const def of projections.values()) {
        stateCells.set(def.key, def.apply(stateCells.get(def.key), event));
      }
    },
    /** 对齐 dsh-agent-loop/lib/index.js:902-925 的语义 */
    async _preStep(session, claimed = []) {
      const list = handlers.get("agent/pre-step") ?? [];
      const contextBlock = { role: "user", source: { kind: "runtime-context" }, content: "【运行时上下文】" };
      let index = 0;
      const next = async () => {
        if (index >= list.length) return { kind: "enter", messages: [...claimed, contextBlock] };
        const fn = list[index++];
        return fn({ agent: { session }, messages: claimed, turn: 1, step: 1, signal: { aborted: false } }, next);
      };
      return next();
    },
  };
}

const isWm = (m) => m?.source?.kind === "working-memory";
const wmCount = (ms) => ms.filter(isWm).length;
const wmBody = (ms) => ms.filter(isWm)[0].content.map((c) => c.text).join("\n");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

const tmpRoots = [];
async function makeWorkspace(label) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `wm-${label}-`));
  tmpRoots.push(dir);
  return dir;
}

/* ------------------------------------------------------------------ 开始 */

console.log("=== 1. 插件契约 ===");
check("导出 name = 'working-memory'", mod.name === "working-memory", mod.name);
check("inject 含 sessionProjections / tools", mod.inject.includes("sessionProjections") && mod.inject.includes("tools"), mod.inject.join(", "));
check("导出了 Config", mod.Config !== undefined, typeof mod.Config);

const cwdA = await makeWorkspace("a");
const SESS = { id: "sess-A", title: "会话A标题", header: { cwd: cwdA } };
const ctx = makeCtx();
const dispose = mod.apply(ctx, {});
check("注册了 4 个工具", ctx._tools.size === 4, [...ctx._tools.keys()].join(", "));
check("含 start / save / list / recall", ["working_memory_start", "working_memory_save", "working_memory_list", "working_memory_recall"].every((n) => ctx._tools.has(n)));
check("注册了 workingMemoryInjection 投影", ctx._projections.has("workingMemoryInjection"));
check("返回 disposer", typeof dispose === "function");

console.log("\n=== 2. 没有需求时不注入 ===");
let decision = await ctx._preStep(SESS, [{ role: "user", content: "你好" }]);
check("空会话不注入记忆块", wmCount(decision.messages) === 0, decision.messages.map((m) => m.source?.kind ?? "普通").join(" | "));
await new Promise((r) => setTimeout(r, 60)); // writeEntryMap 是异步的
check(
  "空会话也会生成 WORKING.md（作为插件确实加载了的证据）",
  fs.existsSync(path.join(cwdA, ".dsh", "WORKING.md")),
  path.join(cwdA, ".dsh", "WORKING.md"),
);
check(
  "此时 .dsh/work 下还没有会话目录（不凭空造状态）",
  !fs.existsSync(path.join(cwdA, ".dsh", "work", "sess-A")),
);

console.log("\n=== 3. 建档：session-state.json 的字段（问题1）===");
const start = ctx._tools.get("working_memory_start");
const r1 = await start.execute(
  {
    id: "memory-system",
    name: "构建跨会话记忆系统",
    query: "先做第一步，然后把工作记忆按 Harness 的方式管起来",
    goal: "在 DSH 里建立分层记忆：常驻规则层 + 工作记忆",
  },
  { agent: { session: SESS } },
);
check("建档返回 created=true", r1.created === true, JSON.stringify(r1));
check("状态默认进行中", r1.status === "进行中", r1.status);
check("按会话 id 建了独立文件夹", fs.existsSync(path.join(cwdA, ".dsh", "work", "sess-A")), r1.statePath);
check("文件名是 session-state.json", r1.statePath.endsWith("session-state.json"), r1.statePath);

const st = readJson(r1.statePath);
check("① 记录了会话 id", st.session.id === "sess-A", st.session.id);
check("① 记录了会话标题", st.session.title === "会话A标题", st.session.title);
check("① 记录了会话时间(startedAt/updatedAt)", st.session.startedAt > 0 && st.session.updatedAt > 0, `${st.session.startedAt} / ${st.session.updatedAt}`);
check("① 记录了当前 active 需求名", st.activeDemandId === "memory-system", st.activeDemandId);
check("① 需求清单存在", Array.isArray(st.demands) && st.demands.length === 1, st.demands.length);
const d0 = st.demands[0];
check("① 需求记录了需求名", d0.name === "构建跨会话记忆系统", d0.name);
check("① 需求记录了原始 query", d0.query.includes("先做第一步"), d0.query);
check("① 需求记录了处理状态", d0.status === "进行中", d0.status);
check("① 需求记录了处理时间", d0.createdAt > 0 && d0.updatedAt > 0, `${d0.createdAt} / ${d0.updatedAt}`);
check("① 需求记录了详情快照（切回可恢复）", d0.handoffSnapshot !== undefined && typeof d0.handoffSnapshot === "object");

console.log("\n=== 4. 写详情：handoff.md 的字段（问题2）===");
const save = ctx._tools.get("working_memory_save");
await save.execute(
  {
    status: "进行中",
    decisions: ["偏好层与工作记忆分两个插件", "不建跨会话索引"],
    done: ["修掉压缩丢失", "工作记忆改为 per-session 存储"],
    blockers: ["bundle 层不生效"],
    next: ["生成当前会话的两个文件", "重启验证"],
    files: ["dsh-plugin-working-memory/lib/index.js"],
  },
  { agent: { session: SESS } },
);
const handoffFile = path.join(cwdA, ".dsh", "work", "sess-A", "handoff.md");
check("② handoff.md 已生成", fs.existsSync(handoffFile), handoffFile);
const hf = fs.readFileSync(handoffFile, "utf8");
check("② 记录了当前 active 需求的需求名", hf.includes("当前需求：构建跨会话记忆系统"), hf.split("\n")[0]);
check("② 记录了需求目标", hf.includes("需求目标") && hf.includes("在 DSH 里建立分层记忆"));
check("② 记录了需求状态", hf.includes("需求状态") && hf.includes("进行中"));
check("② 记录了关键决策/已完成/卡点/下一步", ["关键决策", "已完成", "卡点", "下一步"].every((s) => hf.includes(s)));
check("② 标注了会被覆盖写", hf.includes("覆盖写"));

console.log("\n=== 5. 注入：内容与安全边界 ===");
decision = await ctx._preStep(SESS, [{ role: "user", content: "继续" }]);
check("能找到工作记忆块", wmCount(decision.messages) === 1, decision.messages.map((m) => m.source?.kind ?? "普通").join(" | "));
check("记忆块落在最尾部", isWm(decision.messages[decision.messages.length - 1]));
const body = wmBody(decision.messages);
check("含当前需求名", body.includes("构建跨会话记忆系统"));
check("含目标", body.includes("在 DSH 里建立分层记忆"));
check("含下一步", body.includes("重启验证"));
check("含卡点", body.includes("bundle 层不生效"));
check("含「不是当前指令」声明", body.includes("不是当前指令"));
check("含「不构成证据」声明", body.includes("不构成证据"));
console.log("      ---- 注入正文 ----");
console.log(body.split("\n").map((l) => "      " + l).join("\n"));

console.log("\n=== 6. 不重复注入 / 状态变更后替换 ===");
const d2 = await ctx._preStep(SESS, [{ role: "user", content: "再问" }]);
check("同一状态不重复注入", wmCount(d2.messages) === 1, `实际 ${wmCount(d2.messages)} 份`);
await save.execute({ next: ["新的一步"] }, { agent: { session: SESS } });
const d3 = await ctx._preStep(SESS, [{ role: "user", content: "继续" }]);
check("状态变更后仍只有一份", wmCount(d3.messages) === 1, `实际 ${wmCount(d3.messages)} 份`);
check("注入反映最新状态", wmBody(d3.messages).includes("新的一步"));

console.log("\n=== 7. 压缩后补回（Harness 明确的恢复点）===");
ctx._emitEvent(SESS, { type: "compact/end", seq: 42, time: 2000 });
const d4 = await ctx._preStep(SESS, [{ role: "user", content: "【摘要】此前对话已压缩" }]);
check("压缩后重新注入", wmCount(d4.messages) === 1, `实际 ${wmCount(d4.messages)} 份`);

console.log("\n=== 8. 需求切换：快照完整恢复（核心）===");
// 需求 A 已完成，切到需求 B
await save.execute({ status: "已完成" }, { agent: { session: SESS } });
await start.execute(
  { id: "feishu-sheet", name: "整理飞书招聘表", query: "把两条面试记录改成简历评估中", goal: "同步面试状态" },
  { agent: { session: SESS } },
);
let stX = readJson(path.join(cwdA, ".dsh", "work", "sess-A", "session-state.json"));
check("需求清单累计 2 条", stX.demands.length === 2, stX.demands.map((d) => d.id).join(", "));
const aRec = stX.demands.find((d) => d.id === "memory-system");
check("需求 A 的状态被记住（已切走后仍是已完成）", aRec.status === "已完成", aRec.status);
check("需求 A 的快照非空（不只是状态标签）", aRec.handoffSnapshot.next.includes("新的一步"), JSON.stringify(aRec.handoffSnapshot.next));

// handoff.md 现在指向 B
check("handoff.md 已覆盖为需求 B", fs.readFileSync(handoffFile, "utf8").includes("当前需求：整理飞书招聘表"));
const dSwitch = await ctx._preStep(SESS, [{ role: "user", content: "开始" }]);
check("注入的是需求 B", wmBody(dSwitch.messages).includes("整理飞书招聘表"));
check("注入里列出其他需求（便于切回）", wmBody(dSwitch.messages).includes("memory-system"), "");
check("注入里带其他需求的状态", wmBody(dSwitch.messages).includes("已完成"));

// 切回需求 A —— 应当从快照完整恢复，而不是空壳
const rBack = await start.execute({ id: "memory-system" }, { agent: { session: SESS } });
check("切回 A 返回 created=false", rBack.created === false, rBack.created);
check("切回后状态从快照恢复为已完成", rBack.status === "已完成", rBack.status);
const hfBack = fs.readFileSync(handoffFile, "utf8");
check("切回后 handoff 恢复需求 A 的名字", hfBack.includes("当前需求：构建跨会话记忆系统"));
check("切回后 handoff 恢复目标", hfBack.includes("在 DSH 里建立分层记忆"));
check("切回后 handoff 恢复下一步（不是空壳）", hfBack.includes("新的一步"), hfBack.includes("新的一步") ? "" : "❌ 详情丢失");
check("切回后 handoff 恢复卡点", hfBack.includes("bundle 层不生效"));
check("切回后 handoff 恢复关键决策", hfBack.includes("不建跨会话索引"));

console.log("\n=== 9. list / recall ===");
const list = ctx._tools.get("working_memory_list");
const lr = await list.execute({}, { agent: { session: SESS } });
check("list 返回 2 个需求", lr.demands.length === 2, lr.demands.map((d) => d.id).join(", "));
check("list 标出 active 需求", lr.activeDemandId === "memory-system", lr.activeDemandId);
check("list 带原始 query（恢复意图用）", lr.demands.every((d) => typeof d.query === "string"));
check("list 带处理时间与状态", lr.demands.every((d) => d.createdAt > 0 && d.updatedAt > 0 && typeof d.status === "string"));
check("list 给出两个文件路径（可人工核验）", lr.statePath.endsWith("session-state.json") && lr.handoffPath.endsWith("handoff.md"), lr.statePath);

const recall = ctx._tools.get("working_memory_recall");
const rr = await recall.execute({}, { agent: { session: SESS } });
check("recall 返回 active 需求完整详情", rr.demand !== null && rr.demand.id === "memory-system", rr.demand?.id);
check("recall 详情含 goal/status/next", rr.demand.goal !== "" && rr.demand.status === "已完成" && rr.demand.next.length > 0);
check("recall 返回其他需求索引", rr.others.length === 1 && rr.others[0].id === "feishu-sheet", JSON.stringify(rr.others));
const rrB = await recall.execute({ id: "feishu-sheet" }, { agent: { session: SESS } });
check("可按 id 读非 active 需求的快照", rrB.demand.goal === "同步面试状态", rrB.demand.goal);

// 非 active 需求的详情不在 handoff.md 里（handoff.md 只保存 active 需求），
// 所以 render 指的路径必须正确，否则用户按图索骥会扑空。
const renderOf = (args, value) => recall.output.render(args, value).map((b) => b.text).join("");
const textB = renderOf({ id: "feishu-sheet" }, rrB);
check("非 active 需求被标为 非 active", rrB.demand.isActive === false && textB.includes("非 active"), textB);
// 精确断言：不能把 handoff 当作详情出处（提示语里可以提到 handoff.md 这个词来解释"那里没有"）
check("非 active 需求不把 handoff 当详情出处", !textB.includes("需求详情："), textB);
check("非 active 需求不引用 handoff 文件路径", !textB.includes(rrB.handoffPath), textB);
check("非 active 需求指向 session-state.json 的快照", textB.includes(rrB.statePath) && textB.includes("handoffSnapshot"), textB);
const textA = renderOf({}, rr);
check("active 需求仍指向 handoff.md", rr.demand.isActive === true && textA.includes("需求详情：") && textA.includes(rr.handoffPath), textA);

console.log("\n=== 10. 会话隔离（每个会话一个文件夹）===");
const cwdB = await makeWorkspace("b");
const SESS_B = { id: "sess-B", title: "会话B标题", header: { cwd: cwdB } };
const dB = await ctx._preStep(SESS_B, [{ role: "user", content: "新会话" }]);
check("另一个工作区的会话不注入（无需求）", wmCount(dB.messages) === 0, `实际 ${wmCount(dB.messages)} 份`);
await start.execute({ id: "other", name: "别的需求" }, { agent: { session: SESS_B } });
check("会话 B 有自己的文件夹", fs.existsSync(path.join(cwdB, ".dsh", "work", "sess-B", "session-state.json")));
const stB = readJson(path.join(cwdB, ".dsh", "work", "sess-B", "session-state.json"));
check("会话 B 的清单只有自己的需求", stB.demands.length === 1 && stB.demands[0].id === "other", stB.demands.map((d) => d.id).join(", "));
check("会话 B 标题独立记录", stB.session.title === "会话B标题", stB.session.title);

console.log("\n=== 11. 入口地图 WORKING.md（只读，供人看）===");
const entryFile = path.join(cwdA, ".dsh", "WORKING.md");
check("WORKING.md 已生成", fs.existsSync(entryFile), entryFile);
const em = fs.readFileSync(entryFile, "utf8");
check("标注只读", em.includes("只读"));
check("列出会话及其当前需求", em.includes("sess-A") && em.includes("构建跨会话记忆系统"));
check("列出需求数与状态", em.includes("已完成"));
check("说明了两个文件的分工", em.includes("session-state.json") && em.includes("handoff.md"));

console.log("\n=== 12. 列表截断必须显式说明（防静默截断）===");
const many = Array.from({ length: 12 }, (_, i) => `步骤 ${i + 1}`);
await save.execute({ next: many }, { agent: { session: SESS_B } });
const dTrunc = await ctx._preStep(SESS_B, [{ role: "user", content: "看" }]);
const bodyTrunc = wmBody(dTrunc.messages);
check("超出上限时说明了未展开的条数", bodyTrunc.includes("另有 4 条未展开"), bodyTrunc.includes("另有") ? "" : bodyTrunc);
check("说明里指出完整内容的位置", bodyTrunc.includes("handoff.md"));
check("展开条数正好等于上限 8", (bodyTrunc.match(/^- 步骤 /gm) ?? []).length === 8, String((bodyTrunc.match(/^- 步骤 /gm) ?? []).length));

// 边界：恰好等于上限时不得误报截断
await save.execute({ next: many.slice(0, 8) }, { agent: { session: SESS_B } });
const dEdge = await ctx._preStep(SESS_B, [{ role: "user", content: "边界" }]);
const bodyEdge = wmBody(dEdge.messages);
check("恰好等于上限时不出现截断提示", !bodyEdge.includes("另有"), bodyEdge.includes("另有") ? "误报截断" : "");
check("恰好等于上限时 8 条全展开", (bodyEdge.match(/^- 步骤 /gm) ?? []).length === 8, String((bodyEdge.match(/^- 步骤 /gm) ?? []).length));

// 空列表：该段整段省略（记录既有行为，避免以后误判）
check("空列表的段落被整段省略", !bodyEdge.includes("卡点："), bodyEdge.includes("卡点：") ? "出现了空卡点段" : "");

dispose();
check("disposer 卸载工具", ctx._tools.size === 0, ctx._tools.size);

for (const dir of tmpRoots) await fsp.rm(dir, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败"} —— 通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
