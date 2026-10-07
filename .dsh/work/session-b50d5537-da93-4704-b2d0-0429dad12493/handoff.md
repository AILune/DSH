# 当前需求：构建跨会话记忆系统

<!-- 由 dsh-plugin-working-memory 覆盖写入：切换需求时会整体重写本文件 -->
<!-- 每个需求的详情快照另存于 session-state.json，切回时据此恢复 -->
<!-- 会话: session-b50d5537-da93-4704-b2d0-0429dad12493 -->
<!-- 需求 id: memory-system -->
<!-- 需求处理时间: 创建 2026-10-03T11:43:53.419Z / 更新 2026-10-07T12:31:31.195Z -->

## 需求目标

在 DSH 里建立分层跨会话记忆：常驻规则层（用户偏好）+ 工作记忆（需求状态），并参考服务端 Harness 的状态层做法；并让这套东西能在用户的两台机器之间同步。

## 需求状态

进行中

## 关键决策

- 【已确认·推翻旧结论】bundle 层工作正常：插件自带的 cordis.patch.yml 被正确读取并挂载。之前记录的「bundle 层本机不生效」是误判，根因是 returns bug 导致插件从未成功挂载过一次
- 【已确认】GUI 插件开关改的就是 dsh.profile.bundles，而且【热生效，不需要重启】——实测同一进程内开关从关到开，插件 81 秒后恢复工作
- 【已确认】重复挂载会让 GUI 开关失效：profile 的 cordis.patch.yml 直挂位于组装顺序最后一层（bundles → cordis.patch.yml → overlays），后写层获胜
- 【已确认】插件被卸载时工具是「静默消失」的：调用返回 unknown tool，不报装载错误。这是排查装载问题最直接的信号
- 【已确认】cordis 装载器是裸 await import()（cordis-plugin-loader/lib/index.js:223，无 ?t= 清缓存参数）⇒ 改代码后必须重启 DSH，否则进程内 ESM 缓存仍是旧模块
- 【已确认·纠正认知】偏好层的数据从来不是「每轮从磁盘读」：域在 open 时就把记录 load 进内存 Map，渲染只读内存。每步真正发生的是 applicable() 遍历整表 + 排序（O(n log n)）。所以这是重算问题，不是 I/O 问题
- 【已确认·按用户要求】常驻规则层改为「开场算一次、写入才重算」：storeVersion 版本号 + 按 cwd 分槽的 blockCache（上限 64，最简淘汰）。新会话第一次 assemble 时算一次（等价于开场加载），写入/删除推进 storeVersion 后立刻重算。缓存按 cwd 而非 session 分槽：内容只由 cwd 决定，同一工作区的多个会话共用一份
- 【已确认·关键陷阱】session/flush 每轮都会写记录（injectCount/lastInjectedAt），但它**故意不推进 storeVersion** —— 渲染只读 text/scope/evidence/updatedAt，计数变化不该让系统提示词重算；否则每轮 flush 都白送一次前缀缓存失效。已用断言锁住（flush 前后文本必须完全相同）
- 【已确认】写入提醒的渲染**故意不进缓存**：它必须在本轮出现、轮末清除，本质上属于「本轮」。所以每步仍会做：一次 blockCache 查表 + 一次 pendingNotices 查表 + 可能的字符串拼接
- 【已确认】缓存断言有牙的证明：把「缓存命中」这一行禁用（等于退回每步重算）→ §22 精确红一条（159/1）。测试用「绕过插件直接改底层 _files 里的记录」来证明缓存真的命中
- 【已确认】缓存带来的不只是省 CPU：系统提示词在两次写入之间逐字节恒定（前缀缓存不被扰动），且「什么时候会变」变成显式事件（storeVersion++）而不是渲染逻辑的涌现性质——后者只要有人往 renderBlock 里加个时间戳就会静默让每步失效
- 【已确认】injectCount 改为由 injectedSessions.length 推导，不再累加。旧写法在超过 128 上限后脱钩（实测 130 个会话 → injectCount=130 而列表 128；被裁掉的会话再现会虚增到 131）。已加永久回归断言（§21）并做变异验证：恢复累加写法时精确报 [130,128] 与 [131,128]
- 【已确认】同一 id 在同一轮里被写多次时，待告知只保留最后一笔（去重），避免回复末尾出现两行完全相同的「已写入/更新 X」
- 【已确认】偏好层挂 systemPrompt.section（name=memory:standing-rules，order=DEPLOYMENT_PERSONA_PREFIX+1），不再插 user 消息、不再每步挪尾部。section.text 必须是同步函数：平台每次 assemble 都重新求值（dsh-system-prompt/lib/index.js:342）——这正是写入提醒能生效的前提
- 【已确认】assemble 每步调用一次（dsh-agent-loop/lib/index.js:907 preStep 内），且 renderPrompt(assembly) 在 :1047 生成真正发给模型的提示词
- 【已确认】getSectionOrder / getContextOrder 的实现就是 return XXX_ORDERS[name]，未知名字返回 undefined ⇒ undefined+1=NaN ⇒ section()/context() 抛 TypeError ⇒ apply() 中断、插件静默挂不上。两处都已加 Number.isFinite 兜底
- 【已确认】写入提醒的时序保证：agent/turn-stopping 在 dsh-agent-loop/lib/index.js:999 派发，位于 await this.step(decision) 之后、nextStep 为空时。所以「写入 → 下一步 assemble（提醒已在其中）→ 模型写最终回复 → 轮末清除」顺序成立
- 【已确认】session/flush 是每请求持久化检查点，异常会向监听器外抛（dsh-session-persistence-jsonl 是核心消费者）⇒ 插件里的 try/catch 是承重的
- 诊断信号（按直接程度排序）：① 工具名是否存在（unknown tool = 未装载）② 运行时快照里是否出现「常驻规则层：…版本 N」这一行（★现已可用，直接回答「挂上了没/有几条/版本多少」）③ 工作区 .dsh/WORKING.md 的「生成于」时间戳 ④ 偏好层 injectCount/lastInjectedAt
- 工作记忆的 .dsh/work/<会话id>/ 文件夹只在 working_memory_start / working_memory_save 被调用时创建，因此【文件夹存在与否不能用来判断插件是否工作】
- 记忆分四层：短期（平台自带压缩）、工作记忆（需求状态）、长期（未做）、常驻规则层（用户偏好）
- 【已确认·按用户要求】偏好层另注册一行 systemPrompt.context()（name=memory:standing-rules-status，order=SUBAGENT_DELEGATION+10，默认开启）。理由：偏好块进的是系统提示词，而系统提示词既不落盘也不回显，偏好层因此成了四层里唯一在 GUI 上完全看不见的层，而本项目最痛的历史故障恰是插件静默不挂载。context() 走的才是每轮回显的运行时快照通道（沙箱 110 / 审批 115 / 子代理 120 都是它）
- 【已确认】状态标记的计数取自同一个 blockCache 槽位（槽位扩展为 {version,text,total,injected,global,workspace}），所以它也是 O(1)。已用断言锁住：绕过插件直接改底层记录时，段落与标记都不变
- 【已确认】老版本 DSH 缺 systemPrompt.context() 时必须降级而不是抛错：抛错会让 apply() 中断、插件静默挂不上。已用 typeof 检查 + warn 兜底，并有专门断言（此时 3 个工具照常注册）
- 【已确认】状态标记不报「缓存是否命中」这类易抖字段：同一 storeVersion 下命中与否取决于同一步内谁先调用，会闪烁。改报「版本 N + 条目数」，只在写入/删除时变化 —— 这正是「有没有重新加载」的稳定信号
- 【★已修正·旧验收判据是错的】assemble() 产出两个互不相同的集合（dsh-system-prompt/lib/index.js:338-354）：assembly.sections 经 renderPrompt 进系统提示词（不回显给对话）；assembly.contexts 经 joinContextSections 进「Current runtime context…」运行时快照（每轮回显给模型和 GUI）。偏好层挂 section() ⇒ 按设计在对话里永远看不到；状态标记挂 context() ⇒ 每轮都在。之前让用户「在对话里找偏好块」的验收判据作废
- 【已确认】两个注册口都存在：section() 在 dsh-system-prompt/lib/index.js:240，context() 在 :266，另有 suppressRuntimeContext() 在 :276。要让某层每轮可见/可核验，就得注册 context() 而不是 section()
- 【★新】测试断言自己也会写错，且错法很隐蔽：探针里「缺 cwd 时不该有工作区条目」这条断言依赖了【探针的启动目录】（缺 cwd 会回落 process.cwd()）。从工作区根启动时 process.cwd() 正好等于工作区，于是工作区条目本就该出现，断言假红。教训：凡涉及 cwd 归属的断言，必须用显式 cwd 来验
- 【已确认】workspaceKeyFor(cwd) = basename 压成 slug(≤24) + 对【完整 cwd 字符串】做 31 哈希转 36 进制。所以同一工作区的子目录（如 <ws>\dsh-source）算【不同】工作区，该条偏好静默不生效。已在探针里显式锁住这个现状
- 【★已确认·跨机架构】账号登录不携带任何文件：dsh-deepseek-account 的能力面只有登录态 / AccountProfile（稳定账户 ID、头像）/ balance 与 bonus / device identity，文档原文「Credentials are Host-only」「never enter model prompts, Session logs, or tool results」。整份包表里也不存在任何云同步包；名字像远程的 dsh-api-remotes 实为本机 Host↔Client 的 BFF 门面（owns no physical transport or Host service discovery）⇒ 会话与插件都不会因登录同一账号而迁移，同步必须自己做
- 【★已确认·同一个病 + 纠正旧说法】三处跨机可移植性全都挂在绝对路径上：①偏好层 workspace scope key 哈希完整 cwd ②会话日志桶名是工作区路径 slug（dsh-session-persistence-jsonl/lib/index.js:862，非 [A-Za-z0-9._-] 的字符编码为 ~XXXX~，故 D:\文档\… → --D-~6587~6863-…--）③storages/workspace.json 里 workspaceId → path。同时纠正：DSH 其实已给工作区分配稳定 UUID（fdcceebc-57f8-4d8f-b9df-8ca5366e0598），但会话桶名与偏好 key 用的都是路径而非该 UUID —— 这才是「换路径就静默失效」的根因。推论：两机把工作区放在完全相同的绝对路径，可让三处同时对齐，零代码改动
- 【已确认·偏好层同步的唯一可行路径】dsh-storage-json 的 Config 就是 {root}（dsh-base/cordis.patch.yml 默认 root: !!js dshHomePath('storages')），dsh-storage-domain 有 routes 支持按域路由后端，profile 的 cordis.patch.yml 是最后一层 ⇒ 加一条 - id: storage-json + config.root 覆盖即可把偏好数据挪进工作区随 git 走，不必改插件代码。代价：session_projcache 与 workspace.json 同根，必须 gitignore 掉（storage-json 把后端服务名硬编码为 'json'，所以第二个 JSON 后端实例会撞名，不能只给 memory 域换根）
- 【已确认】deploy 脚本写进 profile 的依赖是按本机现算的（path.join(PROFILE,'node_modules',NAME)），所以 B 机路径不同会自动适配；真正要改的只有 PROFILE 常量。而 lark-doc 的 DEFAULT_BIN_CANDIDATES[0] 虽写死 85448，但 resolveBinary 取「第一个存在的候选」且候选[1] 由 process.env.APPDATA 构造 ⇒ 不是阻塞项，只是死条目
- 【已确认·沙箱边界】~/.dsh 在 workspace-write 下不可写（读得到，Copy-Item 被拒）⇒ 所有部署类操作必须由用户在沙箱外执行。替代验证法：把 DSH_HOME 指向工作区内的假 profile（tmp-sync-test/home/profiles/desktop），整条部署链路可在沙箱内跑通 —— 已实测 deploy-all.mjs 3/3、71 项校验全绿、exit 0

## 已完成

- 偏好层重构完成：从 agent/pre-step 插 user 消息改为挂 systemPrompt.section（memory:standing-rules，order=persona-prefix+1），删掉 sessionProjections 依赖，无残留死符号
- 读取时机改按用户要求落地：常驻规则层「开场算一次、写入才重算」（storeVersion + 按 cwd 分槽 blockCache）；写入/删除推进版本号让它立刻重算。注意 flush 刻意不推进版本号
- 写入提醒机制落地：noteWrite 按会话 id 记账 → 下一步 assemble 渲染提醒段 → agent/turn-stopping 清空；created/updated/deleted 都覆盖；同一 id 一轮内去重
- 挖出并修掉 getSectionOrder 的 NaN 陷阱（未知段落名会让 section() 抛 TypeError 从而插件静默挂不上），并用真实 SystemPrompt 做负例对照验证
- 修掉子代理发现的真 bug：injectCount 超过 128 会话上限后与 injectedSessions 脱钩（130 vs 128，再现时虚增到 131）。改为由列表长度推导，加 §21 永久回归断言 + 变异验证
- ★状态标记落地并按用户选择默认开启：注册 systemPrompt.context（name=memory:standing-rules-status，order=SUBAGENT_DELEGATION+10），每轮在运行时快照里显示「常驻规则层：共 N 条偏好（global g / 本工作区 w），本轮注入 i 条[，另有 k 条未注入] · 版本 v」。blockCache 槽位扩展为 {version,text,total,injected,global,workspace} 以支撑它，保持 O(1)
- ★测试补齐：run-tests.mjs 新增 §23（16 项）——标记注册在 contexts 而非 sections、order 锚点、空库/写入/删除后的计数与版本、跨工作区隔离、不重算（绕过改写不进标记）、超上限「另有 N 条未注入」、域未就绪显示「未就绪」、缺 context() 时 apply 不抛错且 3 个工具照常注册 + 留 warn；test-module-load.mjs 补 context 注册契约
- ★探针扩展并全绿（23 项）：新增「状态标记是否进了 runtime context 快照」一节（含快照前缀、计数与版本正则、原文打印）；并修正一条我自己写错的断言（见关键决策·测试断言自己也会写错），另把「子目录不算同一工作区」这一已知缺陷显式锁住
- ★重新部署并核对：部署产物 35503 B / sha256 c1a6dfc57326755a，与源码逐字节一致；5 个套件全部跑在【部署产物】上——run-tests 184/0、test-module-load 12/0、test-real-storage 13/0、另两个 exit 0；集成探针 23/0
- ★确认探针不污染真实存储：探针写的是内存副本（mirror:false），跑完真实目录仍只有 3 条记录 + 2 个 .pre-reset 备份，无任何 probe 痕迹
- ★★重启后验收通过（2026-10-07，用户已重启，直接观测到）：本轮运行时快照里出现「常驻规则层：共 3 条偏好（global 2 / 本工作区 1），本轮注入 3 条 · 版本 0」。观测边界这条判据首次被【直接观测】满足，不再需要「部署字节==探针字节」这类间接推理
- ★★写入热加载现场复现：写入 global_user-identity-and-target-roles 后，下一轮快照自动变为「共 4 条偏好（global 3 / 本工作区 1），本轮注入 4 条 · 版本 1」——一次写入 → 计数 +1 且版本 +1 全在 GUI 可见。这是「会话内改偏好则重新加载」的可视化闭环
- ★★用户身份已入偏好层：global_user-identity-and-target-roles（温序 / 2027 届 / 27 届秋招 / 目标岗位 Java 开发工程师 + AI 应用研发工程师）。偏好层现共 4 条（global 3 + 本工作区 1）
- 测试套件全绿且非假绿：两轮变异验证分别精确命中 §21（injectCount 累加）与 §22（缓存命中）
- 查清「重启后对话里看不到偏好块」的真因并纠正自己的错误结论：assemble() 把 sections（→系统提示词，不回显）和 contexts（→运行时快照，回显）分成两个集合，偏好层走 section 所以按设计不可见。不是回归
- 新建决定性集成探针 dsh-source/probe-section-live.mjs（真实 SystemPrompt + 真实磁盘数据 + 部署产物字节），并原样打印系统提示词段落正文与状态标记原文作为可人工核验的痕迹

## 卡点

- 工作记忆写入完全靠助手自觉调 working_memory_save，没有任何压缩前强制落盘机制（本项目最脆的一环；已实证：插件关闭期间完全无法记录，关键结论只能靠对话历史硬撑）
- 关键决策条目早已溢出注入上限：条目总数 = 注入块显示的条数 + 「另有 N 条未展开」的 N。现状：共 34 条，注入 8 条，另有 26 条未展开。需把「长期有效的约束」与「一次性排查结论」分层 —— 把前者留在注入块，把后者压成摘要留在 handoff.md
- 「按会话分目录」意味着新会话从空白开始（用户明确选的语义，但新会话不会自动接续上一个会话的需求）
- 换设备：架构与脚本已就绪（两机同路径 + git 同步工作区 + 每机跑 deploy-all），但 ①git 远程未配置，pull/push 流程尚未真正跑通 ②偏好存储根覆盖与 ~/.dsh 内的数据搬运必须在沙箱外手工执行，B 机尚未落地
- 两个插件的 peer 版本精确钉死在 0.2.0-rc.2，别人 DSH 版本不同会被判不兼容（官方解法：dsh plugin allow-version --accept-risk）
- 已知死代码：工作记忆插件监听的 compact/end 是 v0 旧事件名（当前为 compaction/end），该 handler 从不触发；compactionSeq 只写不读
- 偏好层 workspace scope 的 key 哈希的是 cwd 完整路径字符串（已实测量化：<ws>\dsh-source 与 <ws> 算不同工作区）。在「两机同路径」前提下已不构成问题，但换路径或从子目录开会话仍会静默失效。根治办法：让 scope key 改用随工作区走的稳定 id —— storages/workspace.json 里已经有这个 UUID，只是没被用
- 状态标记每轮多约 60-80 字符的上下文预算（版本不变时逐字节恒定，不扰动前缀缓存）。若日后嫌吵，可用配置项关掉；当前按用户选择默认开启
- ~/.dsh 在 workspace-write 沙箱下不可写（读得到、写被拒）⇒ 真实 profile 的插件部署与偏好存储根迁移只能由用户在沙箱外执行。我只能在沙箱内用假 DSH_HOME 验证链路，无法自证真实 profile 的落地结果

## 下一步

- 决定注入块容量策略：把「长期有效的约束/铁律」留在注入块，把「一次性排查结论」归到 handoff.md 并压成摘要（现已 4 条 / 上限 24，未触限；超限时状态标记会每轮提示「另有 k 条未注入」）
- 确认用户「偏好等记忆」是否也要求工作记忆写入在本轮回复末尾告知（目前只有偏好层有这个机制；工作记忆写入已有工具结果卡片可见）
- 长期记忆层：BGE-base-zh-v1.5 本地 embedding（倾向 ONNX Runtime 量化版，约 100-200MB）；检索语料是磁盘产物，不是聊天记录
- 强制层（hooks）：在压缩发生前强制落盘工作记忆，解决「写入全靠助手自觉」这个最脆的环节
- 给偏好层契约测试补上真实 dsh-tools 校验器那一层（现在偏逻辑，缺输出契约的硬校验）
- 清理死代码：工作记忆插件的 compact/end（v0 旧事件名，从不触发）
- 打包分发：补齐包元数据（description/license/repository/files），写 README；修 lark-doc 的 DEFAULT_BIN_CANDIDATES 硬编码用户名 85448 的绝对路径（死条目，非阻塞）
- 【跨机·步骤1】配 git 远程（私有仓库）并首次 push；B 机 clone 到同一路径 D:\文档\deepseek-harness\default-workspace
- 【跨机·步骤2】在 A 机 profile cordis.patch.yml 末尾加 storage-json 的 root 覆盖（见 SYNC.md §3.1，沙箱外手工），把 ~/.dsh/storages/memory/entries/*.json 搬到工作区新根，重启后验证状态标记的条数不变
- 【跨机·步骤3】B 机落地：启动一次 DSH → 拷 profile cordis.patch.yml → 配 XDCYBER_API_KEY → node deploy-all.mjs → 重启后验证状态标记那一行出现
- 【跨机·可选】把「假 DSH_HOME 部署回归」固化成 deploy-test/run.mjs，让部署链路随时可自证（现在只是一次性命令）
- 清理工作区里的一次性排查脚本与临时产物（已扫出 30+ 个写死本机路径的脚本）；dsh-source/probe-section-live.mjs 与 probe-systemprompt.mjs 都有保留价值，应改为 homedir 推导后长期保留
- 把探针纳入常规回归：改偏好层代码后先跑 5 个套件，再跑 probe-section-live.mjs
- 【求职线·可接续】既有资产：飞书「招聘进度」多维表格（base_token EgB0bvTmGaj8vEsRYHhcN0kgnnd / table_id tblZ6JiLi8jUV6Fe）+ netease-mail 技能（163 邮箱拉取面试邀约/笔试通知）。git 工作区里没有求职简历产物，若要动简历/项目包装需先确认素材在哪

## 涉及文件

- dsh-plugin-memory/lib/index.js
- dsh-plugin-working-memory/lib/index.js
- dsh-source/probe-section-live.mjs
- dsh-source/probe-systemprompt.mjs
- deploy-memory.mjs
- deploy-working-memory.mjs
- deploy-lark-doc.mjs
- dsh-paths.mjs
- deploy-all.mjs
- .gitignore
- .gitattributes
- SYNC.md
- memory-plugin-test/run-tests.mjs
- memory-plugin-test/test-module-load.mjs
- memory-plugin-test/test-real-storage.mjs
- working-memory-test/run-tests.mjs
- working-memory-test/test-tool-contract.mjs
- working-memory-test/test-config-strict.mjs
- seed-session-working-memory.mjs
- verify-seeded-memory.mjs
- .dsh/work/<会话id>/session-state.json
- .dsh/work/<会话id>/handoff.md
- .dsh/WORKING.md
