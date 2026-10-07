/**
 * @deepseek-ai/schemastery 的最小 mock。
 *
 * 插件只用了 z.object / z.natural().min().default() / z.boolean().default() / z.string()。
 * 注意：Cordis 的 resolveConfig 只在插件导出 Config["~standard"] 时才校验，
 * 因此这里的产物不会被真正调用；mock 只需让 Config 能构造出来。
 * Config 的真实形状由部署后的 DSH 用真实 schemastery 校验。
 */
function builder() {
  const chain = {
    min: () => chain,
    max: () => chain,
    default: () => chain,
    required: () => chain,
    optional: () => chain,
    description: () => chain,
  };
  return chain;
}

const z = {
  object: (shape) => ({ __schemastery: "object", shape }),
  string: builder,
  number: builder,
  natural: builder,
  boolean: builder,
  array: builder,
};

export default z;
export { z };
