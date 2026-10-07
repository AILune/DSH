import json, os

ws = r"D:\文档\deepseek-harness\default-workspace"
with open(os.path.join(ws, "lark-all-records.ndjson"), encoding="utf-8") as f:
    rows = [json.loads(l) for l in f if l.strip()]
data = [r for r in rows if "manifest_version" not in r]

for kw in ["千问", "阿里", "招商", "招银", "cmb"]:
    hits = [r for r in data if kw in str(r.get("公司", ""))]
    if hits:
        print(f"=== 公司含「{kw}」的记录: {len(hits)} 条 ===")
        for r in hits:
            print(f"  record_id : {r.get('record_id')}")
            print(f"  公司      : {r.get('公司')!r}")
            print(f"  岗位      : {r.get('岗位')!r}")
            print(f"  应聘部门  : {r.get('应聘部门')!r}")
            print(f"  状态      : {r.get('状态')!r}")
            print(f"  一面时间  : {r.get('一面时间')!r}")
            print(f"  二面时间  : {r.get('二面时间')!r}")
            print(f"  笔试时间  : {r.get('笔试时间')!r}")
            print(f"  Base 地   : {r.get('Base 地')!r}")
            print()
print("=" * 70)
print("全部 146 条的公司名（去重，供确认命名习惯）:")
comps = sorted({str(r.get("公司")) for r in data if r.get("公司")})
print(f"  共 {len(comps)} 个不同公司名")
for c in comps:
    print(f"    {c}")
