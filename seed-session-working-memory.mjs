/**
 * 为**当前会话**生成工作记忆的两个文件：
 *   .dsh/work/<会话id>/session-state.json
 *   .dsh/work/<会话id>/handoff.md
 *
 * 模拟"这个会话已经跑过一段、留下了状态"，以便重启后验证插件能否从文件恢复并注入。
 * 故意**不写** .dsh/WORKING.md —— 留给插件生成，作为"插件确实跑了"的证据。
 *
 * 同时清理旧格式（工作区级 state.json / handoff-<任务id>.md），其内容已迁入新结构。
 */
import fs from "node:fs";
import path from "node:path";

const WS = "D:\\文档\\deepseek-harness\\default-workspace";
const SESSION_ID = "session-b50d5537-da93-4704-b2d0-0429dad12493";
const SESSION_STARTED = 1791027833419; // 取自投影缓存的 identity.createdAt

const workRoot = path.join(WS, ".dsh", "work");
const dir = path.join(workRoot, SESSION_ID);
fs.mkdirSync(dir, { recursive: true });

const now = Date.now();
const H = 3600_000;

/** 一个需求的详情（handoff 的结构化形式） */
function detail(o) {
  return {
    goal: o.goal ?? "",
    status: o.status ?? "进行中",
    decisions: o.decisions ?? [],
    done: o.done ?? [],
    blockers: o.blockers ?? [],
    next: o.next ?? [],
    files: o.files ?? [],
    updatedAt: o.updatedAt ?? now,
  };
}

/* ---------------------------------------------------------- 需求 1（active） */

const memorySystem = detail({
  goal: "在 DSH 里建立分层跨会话记忆：常驻规则层（用户偏好）+ 工作记忆（需求状态），并参考服务端 Harness 的状态层做法。",
  status: "进行中",
  updatedAt: now,
  decisions: [
    "记忆分四层：短期（平台自带压缩）、工作记忆（需求状态）、长期（未做）、常驻规则层（用户偏好）",
    "用户偏好**不能**依赖检索：检索会静默失败，偏好必须无条件常驻，因此偏好层小而全量注入，绝不进向量库",
    "两个插件分开：dsh-plugin-memory 管偏好（每步注入），dsh-plugin-working-memory 管需求状态（按恢复点注入）",
    "工作记忆按**会话分目录**：.dsh/work/<会话id>/{session-state.json,handoff.md}",
    "不建跨会话索引：每个会话独立，新会话从自己的文件夹开始",
    "handoff.md 是覆盖写的，因此 session-state.json 为每个需求留**完整快照**，切回时据此恢复而不是只恢复状态标签",
    "注入不能只做一次：压缩只逐字保留尾部（约 16%），必须每步检查并补注入，且插到尾部",
    "key 分隔符必须用下划线：per-record 存储要求匹配 /^[a-zA-Z0-9_-]+$/（冒号会导致所有写入失败）",
    "拒绝索引方案时不做折中：用户明确不要 index.json",
  ],
  done: [
    "偏好层插件 dsh-plugin-memory：存储、注入、镜像、三个工具（write/recall/delete）",
    "修掉 per-record key 含冒号的致命 bug（曾导致所有写入静默失败）",
    "修掉 injectCount 虚高：session/flush 每轮触发多次 → 改为每会话只计一次",
    "修掉压缩丢失：改为每步检查 + 插到尾部，被摘要后可自动补回",
    "工作记忆插件 dsh-plugin-working-memory：按会话分目录，session-state.json + handoff.md，四个工具",
    "两个插件部署到 profile 并挂载进 profile 补丁层（bundle 层在本机不生效）",
    "自动化测试：偏好层 64+13 项、工作记忆 73+8 项，全绿",
  ],
  blockers: [
    "桌面客户端 bundle 层不生效：dsh.profile.bundles 登记了也不挂载，只能靠 profile 的 cordis.patch.yml 直挂，根因未查清",
    "两个插件因此都不出现在 UI 插件列表里，无法在界面上开关",
    "换设备时偏好层数据（~/.dsh/storages）会丢失；工作记忆在工作区内，但也未纳入版本控制（该工作区不是 git 仓库）",
  ],
  next: [
    "重启 DSH，验证插件能从这两个文件恢复并注入",
    "确认重启后会话 id 是否变化（若变化，需要把文件夹改名为新会话 id）",
    "决定是否把偏好层数据也放进工作区，解决换设备丢失",
    "决定是否 git init 让工作记忆可随代码走",
    "后续：长期记忆 + BGE-base-zh-v1.5 本地 embedding（倾向 ONNX Runtime 量化版，约 100-200MB）",
  ],
  files: [
    "dsh-plugin-memory/lib/index.js",
    "dsh-plugin-working-memory/lib/index.js",
    "deploy-memory.mjs",
    "deploy-working-memory.mjs",
    "memory-plugin-test/run-tests.mjs",
    "working-memory-test/run-tests.mjs",
    ".dsh/work/<会话id>/session-state.json",
    ".dsh/work/<会话id>/handoff.md",
  ],
});

/* --------------------------------------------------------------- 需求 2、3 */

const feishuDocPlugin = detail({
  goal: "把飞书文档的读写做成 DSH 插件，可在会话里直接读写飞书 docx/wiki。",
  status: "已完成",
  updatedAt: now - 6 * H,
  decisions: [
    "做成插件（可执行 ESM，注册工具）而不是 skill（只有 Markdown 说明）",
    "文档读写优先，邮件插件 dsh-plugin-netease-mail 暂缓",
    "读 wiki 节点需要先解析 obj_token，docs 接口读不了多维表格（报 3380002），要走 base 接口",
  ],
  done: [
    "dsh-plugin-lark-doc 五个文件完成并部署到 profile 的 node_modules",
    "lark-cli 授权链路打通（含清理残留 lock 文件导致的 token 锁失败）",
  ],
  blockers: ["该插件已从 dsh.profile.bundles 移除，目前不在启用列表里；依赖条目仍留在 profile package.json"],
  next: ["决定是否重新启用，或清理那条悬空的 file: 依赖"],
  files: ["dsh-plugin-lark-doc/"],
});

const interviewTracker = detail({
  goal: "把网易邮箱里的面试邀约/笔试通知整理进飞书多维表格，维护求职进度。",
  status: "已完成",
  updatedAt: now - 4 * H,
  decisions: [
    "网易 163 邮箱走 IMAP 读取（该账号未开通飞书邮箱，飞书侧查询返回 user not found）",
    "更新状态只能用「状态」字段已有的选项，不要新建选项",
    "进度记在飞书多维表格：base_token EgB0bvTmGaj8vEsRYHhcN0kgnnd，table_id tblZ6JiLi8jUV6Fe，工作表「招聘进度」",
  ],
  done: [
    "整理出 17 个字段、146 条记录的求职进度表",
    "已完成两条状态更新：招商银行 → 简历评估中；去哪儿 → 简历评估中",
  ],
  blockers: ["表里有 8 条日期为 2026-10-15 00:00 的占位记录待清理"],
  next: ["清理占位记录", "后续可从邮箱继续同步新邀约"],
  files: ["~/.dsh/mail163-auth-code.txt（待迁移）"],
});

/* ------------------------------------------------------------------ 写入 */

const state = {
  version: 1,
  session: {
    id: SESSION_ID,
    title: "你好",
    startedAt: SESSION_STARTED,
    updatedAt: now,
  },
  activeDemandId: "memory-system",
  demands: [
    {
      id: "memory-system",
      name: "构建跨会话记忆系统",
      query: "那我如何开发一个跨会话记忆的插件？先这样吧，先分析一下记忆系统包含哪些记忆？我的理解是短期记忆、长期记忆和工作记忆？",
      status: memorySystem.status,
      createdAt: SESSION_STARTED,
      updatedAt: memorySystem.updatedAt,
      handoffSnapshot: memorySystem,
    },
    {
      id: "feishu-doc-plugin",
      name: "飞书文档读写插件",
      query: "做成插件吧，先做读写飞书文档这个",
      status: feishuDocPlugin.status,
      createdAt: SESSION_STARTED + 8 * H,
      updatedAt: feishuDocPlugin.updatedAt,
      handoffSnapshot: feishuDocPlugin,
    },
    {
      id: "interview-tracker",
      name: "面试记录与求职进度维护",
      query: "（整理网易邮箱里的面试邀约，同步到飞书多维表格的求职进度表）",
      status: interviewTracker.status,
      createdAt: SESSION_STARTED + 12 * H,
      updatedAt: interviewTracker.updatedAt,
      handoffSnapshot: interviewTracker,
    },
  ],
};

fs.writeFileSync(path.join(dir, "session-state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");

/** handoff.md：只写当前 active 需求，结构必须与插件 renderHandoff 一致 */
function renderHandoff(session, demand, d) {
  const list = (xs) => (xs.length === 0 ? "- （无）" : xs.map((x) => `- ${x}`).join("\n"));
  const iso = (t) => (t === 0 ? "—" : new Date(t).toISOString());
  return [
    `# 当前需求：${demand.name || demand.id}`,
    "",
    "<!-- 由 dsh-plugin-working-memory 覆盖写入：切换需求时会整体重写本文件 -->",
    "<!-- 每个需求的详情快照另存于 session-state.json，切回时据此恢复 -->",
    `<!-- 会话: ${session.id} -->`,
    `<!-- 需求 id: ${demand.id} -->`,
    `<!-- 需求处理时间: 创建 ${iso(demand.createdAt)} / 更新 ${iso(demand.updatedAt)} -->`,
    "",
    "## 需求目标",
    "",
    d.goal || "（未填写）",
    "",
    "## 需求状态",
    "",
    d.status,
    "",
    "## 关键决策",
    "",
    list(d.decisions),
    "",
    "## 已完成",
    "",
    list(d.done),
    "",
    "## 卡点",
    "",
    list(d.blockers),
    "",
    "## 下一步",
    "",
    list(d.next),
    "",
    "## 涉及文件",
    "",
    list(d.files),
    "",
  ].join("\n");
}

const activeDemand = state.demands.find((x) => x.id === state.activeDemandId);
fs.writeFileSync(path.join(dir, "handoff.md"), renderHandoff(state.session, activeDemand, memorySystem), "utf8");

/* ------------------------------------------------- 清理旧格式（内容已迁入） */

const removed = [];
for (const old of ["state.json", "handoff-memory-system.md"]) {
  const p = path.join(workRoot, old);
  if (fs.existsSync(p)) {
    fs.rmSync(p);
    removed.push(old);
  }
}

console.log("已生成：");
console.log("  " + path.join(dir, "session-state.json"), `(${fs.statSync(path.join(dir, "session-state.json")).size} B)`);
console.log("  " + path.join(dir, "handoff.md"), `(${fs.statSync(path.join(dir, "handoff.md")).size} B)`);
if (removed.length > 0) console.log("\n已清理旧格式（内容已迁入新结构）：\n  " + removed.join("\n  "));
console.log("\n故意未写 .dsh/WORKING.md —— 留给插件生成，作为插件确实跑了的证据。");
