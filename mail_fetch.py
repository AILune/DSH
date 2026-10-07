"""拉取 163 收件箱近 7 天邮件，本地筛选面试/邀约相关。

设计：
  - 邮件全文写入本地 JSON 文件（不进上下文）
  - stdout 只打印摘要表（发件人 / 主题 / 日期）
  - 筛选在本地做，只有命中项才展示细节
"""
import datetime
import email
import email.header
import imaplib
import json
import os
import re
import sys
from email.utils import parsedate_to_datetime

WS = r"D:\文档\deepseek-harness\default-workspace"
ADDR = "jay020513@163.com"
DAYS = 7
OUT_JSON = os.path.join(WS, "mail-raw.json")

CANDIDATES = ["mail-auth-code.txt", "mail-auth-code.txt.txt", "mail-auth-code"]
CODE_FILE = next(
    (os.path.join(WS, n) for n in CANDIDATES if os.path.exists(os.path.join(WS, n))), None
)
if CODE_FILE is None:
    print("❌ 未找到授权码文件")
    sys.exit(2)
with open(CODE_FILE, encoding="utf-8") as f:
    code = f.read().strip()


def dh(raw):
    """解码 MIME 编码的头部。"""
    if raw is None:
        return ""
    parts = []
    for chunk, enc in email.header.decode_header(raw):
        if isinstance(chunk, bytes):
            for e in (enc, "utf-8", "gb18030", "latin-1"):
                if not e:
                    continue
                try:
                    parts.append(chunk.decode(e))
                    break
                except (UnicodeDecodeError, LookupError):
                    continue
            else:
                parts.append(chunk.decode("utf-8", "replace"))
        else:
            parts.append(chunk)
    return "".join(parts).strip()


def body_text(msg, limit=20000):
    """抽取纯文本正文；无 text/plain 时退化到 HTML 去标签。"""
    txt, html = [], []
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            disp = str(part.get("Content-Disposition") or "")
            if "attachment" in disp.lower():
                continue
            if ctype not in ("text/plain", "text/html"):
                continue
            try:
                payload = part.get_payload(decode=True)
                if not payload:
                    continue
                charset = part.get_content_charset() or "utf-8"
                try:
                    s = payload.decode(charset, "replace")
                except LookupError:
                    s = payload.decode("utf-8", "replace")
            except Exception:
                continue
            (txt if ctype == "text/plain" else html).append(s)
    else:
        try:
            payload = msg.get_payload(decode=True)
            s = payload.decode(msg.get_content_charset() or "utf-8", "replace") if payload else ""
        except Exception:
            s = ""
        (txt if msg.get_content_type() == "text/plain" else html).append(s)

    if txt:
        out = "\n".join(txt)
    else:
        out = "\n".join(html)
        out = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", out, flags=re.S | re.I)
        out = re.sub(r"<br\s*/?>|</p>|</div>|</tr>", "\n", out, flags=re.I)
        out = re.sub(r"<[^>]+>", " ", out)
        out = re.sub(r"&nbsp;?", " ", out)
        out = re.sub(r"&amp;", "&", out)
        out = re.sub(r"&lt;", "<", out)
        out = re.sub(r"&gt;", ">", out)
        out = re.sub(r"[ \t]{2,}", " ", out)
        out = re.sub(r"\n{3,}", "\n\n", out)
    return out[:limit]


# 连接
M = imaplib.IMAP4_SSL("imap.163.com", 993, timeout=60)
M.xatom("ID", '("name" "dsh" "version" "1.0" "vendor" "dsh" "contact" "none")')
M.login(ADDR, code)
M.select("INBOX", readonly=True)

since = (datetime.date.today() - datetime.timedelta(days=DAYS)).strftime("%d-%b-%Y")
print(f"搜索收件箱：SINCE {since}（近 {DAYS} 天）")
typ, dat = M.search(None, f'(SINCE "{since}")')
ids = dat[0].split()
print(f"该窗口内邮件数: {len(ids)}")

# 面试相关关键词
KW = ["面试", "邀约", "笔试", "测评", "面试邀请", "面试通知", "一面", "二面", "三面",
      "终面", "offer", "应聘", "应聘者", "候选人", "interview"]

records = []
for i, num in enumerate(ids, 1):
    try:
        typ, data = M.fetch(num, "(RFC822)")
        if typ != "OK" or not data or not isinstance(data[0], tuple):
            continue
        msg = email.message_from_bytes(data[0][1])
        subject = dh(msg.get("Subject"))
        from_ = dh(msg.get("From"))
        to_ = dh(msg.get("To"))
        date_raw = msg.get("Date") or ""
        try:
            dt = parsedate_to_datetime(date_raw)
            date_str = dt.astimezone().strftime("%Y-%m-%d %H:%M")
        except Exception:
            date_str = date_raw
        bl = body_text(msg)
        rec = {
            "uid": num.decode(),
            "date": date_str,
            "from": from_,
            "to": to_,
            "subject": subject,
            "body": bl,
        }
        records.append(rec)
    except Exception as e:
        print(f"  ⚠️ 第 {i} 封解析失败: {e}")

M.logout()

with open(OUT_JSON, "w", encoding="utf-8") as f:
    json.dump(records, f, ensure_ascii=False, indent=1)
print(f"\n全部 {len(records)} 封已写入: {os.path.basename(OUT_JSON)}")
print(f"文件大小: {os.path.getsize(OUT_JSON):,} 字节")

# 本地筛选
def is_hit(r):
    hay = (r["subject"] + " " + r["from"] + " " + r["body"][:4000]).lower()
    return any(k.lower() in hay for k in KW)

hits = [r for r in records if is_hit(r)]
print()
print("=" * 100)
print(f"命中面试/邀约关键词的邮件: {len(hits)} / {len(records)}")
print("=" * 100)
for i, r in enumerate(sorted(hits, key=lambda x: x["date"], reverse=True), 1):
    print(f"{i:>3}. [{r['date']}] {r['subject'][:70]}")
    print(f"      发件人: {r['from'][:80]}")
