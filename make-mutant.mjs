/**
 * 生成一份「故意改回旧 bug」的插件副本，用来验证测试套件真的有牙。
 *
 * 旧 bug：去重靠内存里的 Set（进程重启 / 插件热加载即清零），
 * 且记录里只存数字、不存会话 id。
 *
 * 做法是在真实实现上做三处定点回退，不做整文件重写，避免抄错别的东西。
 */
import fs from "node:fs";

const SRC = "D:\\文档\\deepseek-harness\\default-workspace\\dsh-plugin-memory\\lib\\index.js";
const OUT = "D:\\文档\\deepseek-harness\\default-workspace\\memory-plugin-test\\.mutant-old-dedup.js";

let code = fs.readFileSync(SRC, "utf8");
const edits = [
  // 1. 恢复「内存 Set 去重」的提前返回
  [
    `      const state = ctx.sessionProjections.stateOf(session, INJECTION_KEY);
      if (!state?.entryIds?.length) return;`,
    `      if (typeof sessionId === "string" && mutantSeen.has(sessionId)) return;
      const state = ctx.sessionProjections.stateOf(session, INJECTION_KEY);
      if (!state?.entryIds?.length) return;`,
  ],
  // 2. 恢复「无条件累加」的更新
  [
    `        await table.update(key, (prev) => {
          const seen = Array.isArray(prev.injectedSessions) ? prev.injectedSessions : [];
          // 本会话此前已计入 → 只刷新「最后一次注入时刻」，不再累加计数。
          // 因为去重依据读的是盘上的列表，重启 / 热加载都不会重复计数。
          if (typeof sessionId !== "string" || seen.includes(sessionId)) {
            return { ...prev, lastInjectedAt: now };
          }
          const grown = [...seen, sessionId];
          return {
            ...prev,
            injectedSessions: grown.length > MAX_INJECTED_SESSIONS ? grown.slice(-MAX_INJECTED_SESSIONS) : grown,
            injectCount: (prev.injectCount ?? 0) + 1,
            lastInjectedAt: now,
          };
        });`,
    `        await table.update(key, (prev) => ({
          ...prev,
          injectCount: (prev.injectCount ?? 0) + 1,
          lastInjectedAt: now,
        }));`,
  ],
  // 3. 恢复「flush 后把会话记进内存 Set」
  [
    `      await writeMirror();
    } catch (error) {
      ctx.logger?.warn?.(\`memory: 更新注入计数失败: \${String(error)}\`);`,
    `      if (typeof sessionId === "string") mutantSeen.add(sessionId);
      await writeMirror();
    } catch (error) {
      ctx.logger?.warn?.(\`memory: 更新注入计数失败: \${String(error)}\`);`,
  ],
  // 4. 声明那个内存 Set（放在 handler 之前）
  [
    `  const MAX_INJECTED_SESSIONS = 128;`,
    `  const MAX_INJECTED_SESSIONS = 128;
  const mutantSeen = new Set();`,
  ],
];

for (const [from, to] of edits) {
  const n = code.split(from).length - 1;
  if (n !== 1) {
    console.error(`❌ 第 ${edits.indexOf([from, to]) + 1} 处回退匹配到 ${n} 次（应为 1 次）`);
    process.exit(1);
  }
  code = code.replace(from, to);
}

if (code === fs.readFileSync(SRC, "utf8")) {
  console.error("❌ 副本与原文完全相同，回退没有生效");
  process.exit(1);
}

fs.writeFileSync(OUT, code, "utf8");
console.log(`✅ 已生成变异副本：${OUT}`);
console.log(`   回退点：${edits.length} 处（内存 Set 去重 + 无条件累加 + 不写会话 id）`);
console.log("   该副本应当让测试套件失败 —— 若不失败，说明测试没牙。");
