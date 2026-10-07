import json, os, re

ws = r"D:\文档\deepseek-harness\default-workspace"
with open(os.path.join(ws, "mail-raw.json"), encoding="utf-8") as f:
    recs = json.load(f)

# 只细看真正的面试邀约
WANT = ["招商银行校园招聘视频面试",
        "【阿里巴巴校园招聘】千问事业部面试通知",
        "【阿里巴巴校园招聘】千问事业部面试邀约"]

for r in recs:
    if r["subject"] not in WANT:
        continue
    print("=" * 96)
    print(f"主题: {r['subject']}")
    print(f"发件人: {r['from']}")
    print(f"收件人: {r['to']}")
    print(f"日期: {r['date']}")
    print("-" * 96)
    b = r["body"]
    b = re.sub(r"\n{3,}", "\n\n", b)
    b = re.sub(r"[ \t]{2,}", " ", b)
    print(b[:2600])
    print()
