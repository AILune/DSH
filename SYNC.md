# 跨机器同步手册

两台机器都用 DSH 时，如何保持内容一致。**结论先行：只有「工作区」需要同步，`~/.dsh` 每台机器各自私有。**

---

## 1. 架构：同步什么，不同步什么

DSH 的账号登录**只承载登录态、账户身份、余额额度**，不带任何文件（依据：`@deepseek-ai/dsh-deepseek-account` 文档 —— "Credentials are Host-only"，"never enter model prompts, Session logs, or tool results"）。所以同步只能自己做，分两类处理：

| 内容 | 位置 | 处理方式 |
|---|---|---|
| 插件源码（3 个） | `<工作区>\dsh-plugin-*` | ✅ git |
| 部署脚本 | `<工作区>\deploy-*.mjs`、`dsh-paths.mjs` | ✅ git |
| 工作记忆 | `<工作区>\.dsh\work\<会话id>\`、`.dsh\WORKING.md` | ✅ git（按会话 id 分目录，两台机器不写同一文件） |
| **偏好层（常驻规则层）** | 见第 3 节 —— 需先改存储根，否则在 `~\.dsh` 内不随 git 走 | ⚠️ 需一次配置 |
| 聊天记录（会话日志） | `~\.dsh\sessions\--<路径slug>--\<会话id>\` | ❌ 不同步（见第 6 节） |
| 插件安装副本 | `~\.dsh\profiles\<profile>\node_modules\` | ❌ 每台用 `deploy-all.mjs` 重建 |
| 密钥 | `~\.dsh\.credentials.yaml` | ❌ 手动配 |
| profile 配置 | `~\.dsh\profiles\<profile>\cordis.patch.yml` | ❌ 手动拷（不含本机绝对路径） |

**为什么不能整体同步 `~/.dsh`**：里面有 zstd 流式的会话日志（当前 13.6 MB）、会话投影缓存、账号凭据。用云盘或账号同步这些会**静默损坏或泄露**，而且账号本来就没有这个通道。

---

## 2. 两台机器必须保持一致的两件事

| 项 | 要求 | 原因 |
|---|---|---|
| **工作区绝对路径** | 两台都是 `D:\文档\deepseek-harness\default-workspace` | ① 会话日志桶名由工作区路径 slug 算出（`dsh-session-persistence-jsonl/lib/index.js:862`，非 `[A-Za-z0-9._-]` 字符编码为 `~XXXX~`）② 偏好层的 workspace scope key 哈希的是**完整 cwd**；路径一变，那条偏好会静默失效（数据在但不生效） |
| **DSH 版本** | 尽量一致 | 两个记忆插件的 peer 精确钉死 `0.2.0-rc.2`。版本不同会被兼容性门禁拒绝挂载，需要 `dsh plugin allow-version <包名> <版本> --accept-risk` |

---

## 3. 一次性配置：让偏好层随仓库同步

**前提**：偏好层默认存在 `~\.dsh\storages\memory\entries\`（机器本地），不随 git 走。平台的存储层支持按域指定存储根，所以只要在 profile 补丁层加一条覆盖即可 —— **不需要改插件代码**。

依据：`dsh-base/cordis.patch.yml` 里 `storage-json` 的默认配置是 `root: !!js dshHomePath('storages')`；profile 的 `cordis.patch.yml` 是最后一层（"applied after every bundle layer"），覆盖它即可生效。

### 3.1 在 A 机编辑 `~\.dsh\profiles\desktop\cordis.patch.yml`

在**顶层数组末尾**追加一项（务必先备份该文件）：

```yaml
- id: storage-json
  name: "@deepseek-ai/dsh-storage-json"
  config:
    root: "D:/文档/deepseek-harness/default-workspace/.dsh/storages"
```

> 这个绝对路径在 A、B 两机相同，所以该文件可以直接对拷。若日后工作区路径变了，这一行必须同步改。

### 3.2 把已有偏好记录搬进新位置

```powershell
$dst = 'D:\文档\deepseek-harness\default-workspace\.dsh\storages\memory\entries'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "$env:USERPROFILE\.dsh\storages\memory\entries\*.json" $dst
```

### 3.3 重启 DSH，验证

重启后运行时上下文里那一行应仍显示原来的条数与版本，例如：

```
常驻规则层：共 4 条偏好（global 3 / 本工作区 1），本轮注入 4 条 · 版本 N
```

若显示「共 0 条偏好」，说明存储根没生效或数据没搬对 —— 这一步不会静默失败，标记就是判据。

> ⚠️ 注意：这条覆盖会同时把 `session_projcache`、`workspace.json` 等挪到同一个新根下。
> `.gitignore` 已经排除它们，只保留 `memory/`，所以不会造成 git 冲突。

---

## 4. B 机首次落地

按顺序执行，每步都有可核验的结果。

1. **确认工作区路径一致**：B 机的工作区必须是 `D:\文档\deepseek-harness\default-workspace`。
2. **先启动一次 DSH**（关键）：profile 目录由 DSH 自己 `initProfile()` 创建。`deploy-all.mjs` 只读不建，profile 不存在时会明确报错并提示你先启动一次。
3. **把仓库取到该路径**（`git clone` 或从 A 机拷贝工作区）。
4. **拷 profile 配置**：把 A 机的 `~\.dsh\profiles\desktop\cordis.patch.yml` 覆盖到 B 机同名位置（含第 3 节的存储根覆盖，以及模型 provider 配置）。
5. **配密钥**：确认 B 机的 `~\.dsh\.credentials.yaml` 里有 `XDCYBER_API_KEY`（与 A 机一致）。
6. **装插件**：
   ```
   node deploy-all.mjs
   ```
   预期输出：`通过：3/3`，以及三次 `✅ 部署完成，全部校验通过`。
7. **重启 DSH**。验证：运行时上下文里出现 `常驻规则层：共 N 条偏好…` 那一行。
8. **按需装 lark-cli**（飞书文档插件依赖它）：
   ```
   npm i -g @larksuite/cli
   lark-cli auth login
   ```
   这是 lark 自己的账号认证，**与 DSH 账号无关**。

---

## 5. 日常同步流程

使用 git 远程（推荐私有仓库）作为同步介质：

```powershell
# 开始工作前
git pull

# 收工前
git add -A
git commit -m "说明这次改了什么"
git push
```

**纪律**：同一时刻只在一台机器上编辑。这样永远不会出现需要处理的并发冲突。
即使真的两边都改了：偏好数据是**一个 key 一个文件**，改不同条目会干净合并；改同一条目会得到一次**显式的 git 冲突**让你处理 —— 而不是云盘那种静默覆盖。

> 不建议用云盘直接同步工作区目录：`.git` 目录在两端并发访问下有损坏风险。用 git 远程更稳。

---

## 6. 已知边界

- **聊天记录不同步**。会话日志在 `~\.dsh\sessions\`，是每台机器自己的运行产物。即使工作区路径一致（桶名一致），要让 B 机看到 A 机的历史会话还需要额外合并 `workspace.json` 的会话索引 —— 属于手工操作，不建议纳入日常流程。
- **工作记忆按会话 id 分目录**：B 机新会话会开一个新的 `.dsh\work\<新会话id>\`，不会自动接续 A 机某个会话的当前需求。历史 `handoff.md` 文件在仓库里可以查阅，需要时用 `working_memory_start` 切回对应需求。
- **插件必须安装，不能靠同步文件**：profile 清单里是 `file:` 绝对路径，且插件是可执行代码、有版本兼容门禁。所以 B 机必须跑一次 `deploy-all.mjs`。
- **`lark-cli-repo/`、`dsh-source/node_modules/`、各 `node_modules/` 不入库**（已在 `.gitignore`），克隆后如需运行探针需自行准备。

---

## 7. 附：如何在不碰真 profile 的前提下做部署回归测试

把 `DSH_HOME` 指向工作区内的一个假 profile，整条部署链路（路径解析 → 复制 → 登记 → 71 项校验）就能在沙箱内完整跑通：

```powershell
$ws = 'D:\文档\deepseek-harness\default-workspace'
$fx = "$ws\tmp-sync-test\home\profiles\desktop"
New-Item -ItemType Directory -Force -Path $fx | Out-Null
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json"     "$fx\package.json"     -Force
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" "$fx\cordis.patch.yml" -Force

$env:DSH_HOME = "$ws\tmp-sync-test\home"
node deploy-all.mjs
```

预期：每行都是 `✅`，共 71 项、`exit 0`。这个目录已在 `.gitignore` 中。

---

## 8. 相关文件

| 文件 | 作用 |
|---|---|
| `dsh-paths.mjs` | 路径解析：`$DSH_HOME` > `~/.dsh`；profile 自动探测；命令行解析。任何脚本都不得再出现写死的用户名或盘符 |
| `deploy-all.mjs` | 统一部署入口：依次跑三个插件脚本，任一失败即中止 |
| `deploy-memory.mjs` / `deploy-working-memory.mjs` / `deploy-lark-doc.mjs` | 单个插件部署（各自带完整校验），也可单独运行 |
| `.gitignore` | 排除凭据、隐私、体积项；**保留** `.dsh/`（工作记忆）与 `yaml-check/node_modules`（部署脚本依赖 js-yaml） |
