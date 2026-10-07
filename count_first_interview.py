import json, os

ws = r"D:\文档\deepseek-harness\default-workspace"
p = os.path.join(ws, "lark-all-records.ndjson")

rows = []
with open(p, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
data = [r for r in rows if "manifest_version" not in r]

print(f"表内总记录数: {len(data)}")
print("=" * 74)

# 1) 有「一面时间」字段值的
has_time = [r for r in data if r.get("一面时间") not in (None, "", [], {})]
print(f"\n【读法 A】填了「一面时间」的记录: {len(has_time)} 条")

# 2) 状态恰好是「一面挂」
gua = [r for r in data if (r.get("状态") or []) == ["一面挂"]]
print(f"\n【读法 B】状态 = 「一面挂」的记录: {len(gua)} 条")
print("-" * 74)
for i, r in enumerate(sorted(gua, key=lambda r: str(r.get("一面时间"))), 1):
    print(f"  {i:>2}. {r.get('公司'):<12} 一面时间={r.get('一面时间')}")
    print(f"      岗位={r.get('岗位')}  部门={r.get('应聘部门')}")

# 交叉：一面挂 且 有一面时间
both = [r for r in gua if r.get("一面时间")]
print(f"\n【交叉】状态「一面挂」且填了一面时间: {len(both)} 条")

# 状态分布，供核对
print("\n" + "=" * 74)
print("全部「状态」取值分布:")
from collections import Counter
c = Counter()
for r in data:
    s = r.get("状态")
    key = tuple(s) if isinstance(s, list) else s
    c[key] += 1
for k, v in c.most_common():
    print(f"  {v:>4}  {k}")
