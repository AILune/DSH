import json, os

ws = r"D:\文档\deepseek-harness\default-workspace"
p = os.path.join(ws, "lark-records-sample.ndjson")

rows = []
with open(p, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception as e:
            print("解析失败:", e, line[:120])

# 第一个可能是 manifest
if rows and "manifest_version" in rows[0]:
    print("=== manifest ===")
    m = rows.pop(0)
    for k, v in m.items():
        if k != "fields":
            print(f"  {k}: {v}")
    if "fields" in m:
        print(f"  fields: {len(m['fields'])} 个")

print(f"\n=== 记录数: {len(rows)} ===")
for i, r in enumerate(rows, 1):
    print(f"\n--- 记录 {i}  record_id={r.get('record_id')} ---")
    for k, v in r.items():
        if k == "record_id":
            continue
        if v in (None, "", [], {}):
            continue
        s = json.dumps(v, ensure_ascii=False)
        print(f"    {k}: {s[:150]}")
