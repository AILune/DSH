import json, os, re, datetime

ws = r"D:\文档\deepseek-harness\default-workspace"

# 1. 当前时间
now = datetime.datetime.now()
print("=" * 74)
print("当前时间核对")
print("=" * 74)
print(f"  现在: {now:%Y-%m-%d %H:%M:%S} (周{'一二三四五六日'[now.weekday()]})")

cmb_deadline = datetime.datetime(2026, 10, 2, 9, 0, 0)
print(f"  招行视频面试截止: {cmb_deadline:%Y-%m-%d %H:%M}")
if now > cmb_deadline:
    delta = now - cmb_deadline
    print(f"  ⚠️  已过期 {delta.days} 天 {delta.seconds // 3600} 小时")
else:
    print(f"  还有 {(cmb_deadline - now)}")

# 2. 全部字段名（找有没有 AI面试 / 视频面试 专用字段）
with open(os.path.join(ws, "lark-all-records.ndjson"), encoding="utf-8") as f:
    rows = [json.loads(l) for l in f if l.strip()]
data = [r for r in rows if "manifest_version" not in r]
allkeys = set()
for r in data:
    allkeys.update(r.keys())
allkeys.discard("record_id")
print()
print("=" * 74)
print(f"表内全部字段名（{len(allkeys)} 个）")
print("=" * 74)
for k in sorted(allkeys):
    print(f"  {k}")
ai = [k for k in allkeys if "AI" in k or "ai" in k or "视频" in k or "测评" in k]
print(f"\n  含 AI/视频/测评 的字段: {ai or '（无专用字段）'}")

# 3. 招行邮件细节（补岗位/部门）
with open(os.path.join(ws, "mail-raw.json"), encoding="utf-8") as f:
    recs = json.load(f)
print()
print("=" * 74)
print("招行邮件正文中是否含岗位/部门信息")
print("=" * 74)
for r in recs:
    if "招商银行" in r["subject"]:
        b = r["body"]
        for kw in ["岗位", "职位", "部门", "分行", "信息技术", "AI面试", "AI面试", "邀请码"]:
            for m in re.finditer(kw + r"[：:\s]{0,3}([^\n，。；]{0,40})", b):
                print(f"  [{kw}] ...{m.group(0)[:70]}")
                break
        print(f"\n  正文前 300 字:\n    {b[:300]}")
