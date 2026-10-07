/**
 * 预置本项目的工作记忆，模拟"上一个会话结束时留下的状态"。
 *
 * 这样重启后能立刻验证两件事：
 *  1. 插件能从**外部已存在的**状态文件恢复（而不是只认自己写的）
 *  2. 换会话能接续（新会话读到的是文件里的状态）
 *
 * 注意：这只写状态文件；.dsh/WORKING.md 由插件自己生成，故意不在这里写，
 * 以便验证插件确实生成了它。
 */
import fs from "node:fs";
import path from "node:path";

const WS = "D:\\文档\\deepseek-harness\\default-workspace";
const workDir = path.join(WS, ".dsh", "work");
fs.mkdirSync(workDir, { recursive: true });

const now = Date.now();

const state = {
  version: 1,
  updatedAt: now,
  tasks: [
    {
      id: "memory-system",
      title: "构建跨会话记忆系统",
      createdAt: now,
      updatedAt: now,
      sessions: [],
    },
    {
      id: "job-search-tracker",
      title: "面试记录与求职进度维护",
      createdAt: now,
      updatedAt: now - 3600_000,
      sessions: [],
    },
  ],
};
fs.writeFileSync(path.join(workDir, "state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");

const handoff = `# 工作记忆：构建跨会话记忆系统

<!-- 由人工预置；后续由 dsh-plugin-working-memory 覆盖写入 -->
<!-- 任务 id: memory-system -->
<!-- 最后更新: ${new Date(now).toISOString()} -->

## 目标

在 DSH 里建立分层的跨会话记忆：常驻规则层（用户偏好）+ 工作记忆（任务状态），
参考服务端 Harness 的 AGENTS.md / branch-state.json / handoff.md 三层做法。

## 状态

进行中

## 关键决策

- 记忆分四层：短期记忆（平台自带的压缩）、工作记忆（任务状态）、长期记忆（未做，将来配 BGE 检索）、常驻规则层（用户偏好）
- 用户偏好**不能**依赖检索：检索会静默失败，偏好必须无条件常驻；因此偏好层小而全量注入，绝不进向量库
- 持久化目录：偏好层与工作记忆插件都放在工作区，换设备可延续（对照：~/.dsh/storages 换设备会丢）
- key 分隔符必须用下划线，per-record 存储要求匹配 /^[a-zA-Z0-9_-]+$/
- 注入不能只做一次：压缩（dsh-compaction-basic 的 selectCompactableRange 保留尾部 16%）会把注入块摘要掉，必须每步检查并补注入
- 工作记忆对应关系：state.json ↔ Harness 的 branch-state.json（索引）；handoff-<id>.md ↔ Harness 的 handoff.md（详情）

## 已完成

- 偏好层插件 dsh-plugin-memory：存储、注入、镜像、三个工具
- 修掉 key 含冒号的致命 bug（导致所有写入失败）
- 修掉 injectCount 虚高（session/flush 每轮触发多次 → 改每会话只计一次）
- 修掉压缩丢失：改为每步检查 + 插到尾部，被摘要后可自动补回
- 工作记忆插件 dsh-plugin-working-memory：task 索引 + 详情文件 + 入口地图，会话首步与 compact/end 后恢复
- 两套插件共 116 项自动化测试通过（偏好层 64+13，工作记忆 44+8）

## 卡点

- 桌面客户端的 bundle 层不生效：dsh.profile.bundles 里登记了也不挂载，只能靠 profile 的 cordis.patch.yml 直挂。根因未查清
- 换设备时 ~/.dsh 下的偏好层数据会丢失（工作记忆在工作区内，不受影响）

## 下一步

- 重启 DSH，验证工作记忆插件的注入与恢复
- 决定是否把偏好层数据也迁到工作区内，解决换设备丢失
- 后续：长期记忆 + BGE-base-zh-v1.5 本地 embedding（方案倾向 ONNX Runtime 量化版，约 100-200MB）

## 涉及文件

- dsh-plugin-memory/lib/index.js
- dsh-plugin-working-memory/lib/index.js
- deploy-memory.mjs
- deploy-working-memory.mjs
- memory-plugin-test/run-tests.mjs
- working-memory-test/run-tests.mjs
`;

fs.writeFileSync(path.join(workDir, "handoff-memory-system.md"), handoff, "utf8");

console.log("已预置：");
console.log("  " + path.join(workDir, "state.json"));
console.log("  " + path.join(workDir, "handoff-memory-system.md"));
console.log("  （故意不写 .dsh/WORKING.md —— 留给插件生成，以便验证它确实做了）");
