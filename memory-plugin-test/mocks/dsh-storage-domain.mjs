/**
 * @deepseek-ai/dsh-storage-domain 的 mock。
 *
 * defineDomain / domainTable 照抄真实实现的校验逻辑
 * （见 dsh-storage-domain/lib/index.js:46 domainTable、:61 defineDomain），
 * 这样测试能真正验证插件声明的域 spec 是否合法。
 */

/** 与真实实现同形状：域名/表名必须是 lower_snake_case */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;

export function domainTable(schema) {
  return { valueSchema: schema };
}

export function defineDomain(spec) {
  if (!UNIT_NAME_RE.test(spec.name)) {
    throw new Error(`domain name '${spec.name}' must match ${UNIT_NAME_RE}`);
  }
  if (!Number.isInteger(spec.version) || spec.version < 0) {
    throw new Error(`domain '${spec.name}' version must be a non-negative integer, got ${spec.version}`);
  }
  for (const compat of spec.compatibleVersions ?? []) {
    if (!Number.isInteger(compat) || compat < 0 || compat >= spec.version) {
      throw new Error(`domain '${spec.name}' compatibleVersions entries must be non-negative integers below version ${spec.version}, got ${compat}`);
    }
  }
  if (spec.layout !== undefined && spec.layout !== "single" && spec.layout !== "per-record") {
    throw new Error(`domain '${spec.name}' layout must be 'single' or 'per-record', got ${spec.layout}`);
  }
  for (const table of Object.keys(spec.tables)) {
    if (!UNIT_NAME_RE.test(table)) throw new Error(`domain '${spec.name}' table name '${table}' must match ${UNIT_NAME_RE}`);
  }
  // 真实实现还要求暴露 parse()（parseRecord 会调用它）
  for (const [table, def] of Object.entries(spec.tables)) {
    if (typeof def?.valueSchema?.parse !== "function") {
      throw new Error(`domain '${spec.name}' table '${table}' schema 必须提供 parse()`);
    }
  }
  return spec;
}

export default { defineDomain, domainTable };
