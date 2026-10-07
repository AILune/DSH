import json, os

ws = r"D:\文档\deepseek-harness\default-workspace"
with open(os.path.join(ws, "mail-raw.json"), encoding="utf-8") as f:
    recs = json.load(f)

KW = ["面试", "邀约", "笔试", "测评", "面试邀请", "面试通知", "一面", "二面", "三面",
      "终面", "offer", "应聘", "应聘者", "候选人", "interview"]


def is_hit(r):
    hay = (r["subject"] + " " + r["from"] + " " + r["body"][:4000]).lower()
    return any(k.lower() in hay for k in KW)


miss = [r for r in recs if not is_hit(r)]
print(f"未命中的邮件: {len(miss)} 封 —— 逐封核对，确认里面没有面试邀约")
print("=" * 92)
for i, r in enumerate(sorted(miss, key=lambda x: x["date"], reverse=True), 1):
    body = " ".join(r["body"].split())[:150]
    print(f"\n{i:>2}. [{r['date']}] {r['subject'][:70]}")
    print(f"    发件人: {r['from'][:75]}")
    print(f"    正文片段: {body}")
