import json, os

ws = r"D:\文档\deepseek-harness\default-workspace"

print("=" * 74)
print("① 状态字段的全部合法选项")
print("=" * 74)
p = os.path.join(ws, "lark-fields.json")
if os.path.exists(p):
    with open(p, encoding="utf-8") as f:
        d = json.load(f)
    for fld in d.get("data", {}).get("fields", []):
        if fld.get("name") in ("状态", "是否完成测评/笔试", "岗位", "应聘部门", "Base 地", "公司类型"):
            print(f"\n  字段: {fld['name']}  type={fld['type']}  id={fld['id']}")
            opts = fld.get("options") or []
            if opts:
                for o in opts:
                    print(f"      - {o.get('name')!r}")
            else:
                print("      (无固定选项)")
else:
    print("  未找到 lark-fields.json（需先导出字段）")

print()
print("=" * 74)
print("② 找「去哪儿」的记录")
print("=" * 74)
with open(os.path.join(ws, "lark-all-records.ndjson"), encoding="utf-8") as f:
    rows = [json.loads(l) for l in f if l.strip()]
data = [r for r in rows if "manifest_version" not in r]

for r in data:
    if "去哪儿" in str(r.get("公司", "")):
        print(f"  record_id : {r.get('record_id')}")
        for k, v in r.items():
            if k == "record_id":
                continue
            if v not in (None, "", [], {}):
                print(f"    {k}: {json.dumps(v, ensure_ascii=False)}")
        print()

print("=" * 74)
print("③ 招商银行记录现状")
print("=" * 74)
for r in data:
    if "招商银行" in str(r.get("公司", "")):
        print(f"  record_id : {r.get('record_id')}")
        for k, v in r.items():
            if k == "record_id":
                continue
            if v not in (None, "", [], {}):
                print(f"    {k}: {json.dumps(v, ensure_ascii=False)}")
        print()
