/**
 * @deepseek-ai/dsh-llm 的最小 mock：只提供插件用到的 createUserMessage。
 * 真实签名见 dsh-llm 的导出；这里保持同样的调用形状。
 */
export function createUserMessage({ content, source }) {
  return { role: "user", content, source };
}

export default { createUserMessage };
