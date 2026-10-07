/*
 * 探针：用真实的 SystemPrompt 服务验证「偏好层挂到系统提示词」这个方案的前提。
 *
 * 只验证事实，不做断言美化：
 *  ① getSectionOrder 对已知/未知名字分别返回什么
 *  ② 动态 section（text 为函数）在每次 assemble 时是否重新求值
 *  ③ order 为 NaN 时 section() 是否真的抛错（决定插件里那个兜底是否必要）
 *  ④ 渲染出的最终提示词里是否真的包含我们的段落
 */
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt, { renderPrompt } from "@deepseek-ai/dsh-system-prompt";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? `\n       -> ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const ctx = new Context();
const sp = new SystemPrompt(ctx, {});

console.log("=== ① getSectionOrder ===");
const personaOrder = ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX");
check("已知名字 DEPLOYMENT_PERSONA_PREFIX 返回数字", Number.isFinite(personaOrder), `= ${JSON.stringify(personaOrder)}`);
const unknown = ctx.systemPrompt.getSectionOrder("NO_SUCH_PLACEMENT_AT_ALL");
check("未知名字返回 undefined（不是抛错）", unknown === undefined, `= ${JSON.stringify(unknown)}`);
check(
  "undefined + 1 === NaN —— 这就是插件里兜底要防的东西",
  Number.isNaN(unknown + 1),
  `Number.isNaN(undefined + 1) = ${Number.isNaN(unknown + 1)}`,
);

console.log("\n=== ② order 为 NaN 时 section() 是否抛错（负例对照）===");
let threw = null;
try {
  ctx.systemPrompt.section({ name: "probe:nan", order: unknown + 1, text: "x" });
} catch (error) {
  threw = error;
}
check("NaN order 确实抛 TypeError（证明兜底必要）", threw instanceof TypeError, threw ? `${threw.name}: ${threw.message}` : "没有抛错！");

console.log("\n=== ③ 动态 section 每次 assemble 是否重新求值 ===");
let backing = "第一版内容";
const registered = ctx.systemPrompt.section({
  name: "probe:standing-rules",
  order: Number.isFinite(personaOrder) ? personaOrder + 1 : 100,
  text: () => `## 常驻规则层\n- ${backing}`,
});
check("section() 返回 disposer", typeof registered === "function");

const first = renderPrompt(await ctx.systemPrompt.assemble({}));
check("第一次组装包含第一版内容", first.includes("第一版内容"), JSON.stringify(first.slice(0, 120)));

backing = "第二版内容";
const second = renderPrompt(await ctx.systemPrompt.assemble({}));
check("改数据后第二次组装反映新内容（无需重新注册）", second.includes("第二版内容"), "");
check("且旧内容已消失", !second.includes("第一版内容"));

console.log("\n=== ④ 段落位置与最终提示词 ===");
const assembly = await ctx.systemPrompt.assemble({});
const names = assembly.sections.map((s) => s.name);
console.log(`  段落顺序: ${names.join(" -> ")}`);
const mine = names.indexOf("probe:standing-rules");
const personaIdx = names.findIndex((n) => n.includes("persona-prefix"));
check("我们的段落确实在组装结果里", mine !== -1);
if (personaIdx !== -1 && mine !== -1) {
  check("位置紧随 persona-prefix 之后", mine > personaIdx, `persona@${personaIdx}, ours@${mine}`);
}
check("最终提示词里含我们的段落正文", second.includes("## 常驻规则层"), "");

console.log("\n=== ⑤ 未注册时的行为 ===");
ctx.systemPrompt.section({ name: "probe:empty", order: 200, text: () => "" });
const after = renderPrompt(await ctx.systemPrompt.assemble({}));
check("返回空串的段落被丢弃，不产生空行噪声", !after.includes("\n\n\n\n"), "");

console.log(`\n${failures === 0 ? "✅ 全部通过" : `❌ 失败 ${failures} 项`}`);
process.exit(failures === 0 ? 0 : 1);
