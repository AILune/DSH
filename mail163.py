#!/usr/bin/env python3
"""网易 163 邮箱 IMAP 读取工具。

用法:
  # 列出文件夹
  python mail163.py folders

  # 拉取近 N 天收件箱（默认 7 天），输出 NDJSON 到指定文件
  python mail163.py fetch --days 7 --out mails.ndjson

  # 只输出摘要（发件人/主题/日期），不打印正文
  python mail163.py digest --days 7

  # 关键词过滤（在本地对主题+正文前若干字符匹配）
  python mail163.py fetch --days 7 --out mails.ndjson --keyword 面试 --keyword 邀约

授权码查找顺序（第一个命中的生效）:
  1. 环境变量 MAIL163_AUTH_CODE
  2. --code-file 指定的文件
  3. 默认候选路径（见 DEFAULT_CODE_PATHS）

安全约定:
  - 授权码只在进程内存中使用，任何分支都不打印其内容
  - 连接后立即发 ID 命令（163 强制要求，否则 SELECT 报 Unsafe Login）
  - 全程 readonly 打开邮箱，不会修改任何邮件状态
"""
from __future__ import annotations

import argparse
import datetime
import email
import email.header
import imaplib
import json
import os
import re
import smtplib
import sys
from email.utils import parsedate_to_datetime

IMAP_HOST = "imap.163.com"
IMAP_PORT = 993
SMTP_HOST = "smtp.163.com"
SMTP_PORT = 465

DEFAULT_ADDRESS = "jay020513@163.com"

DEFAULT_CODE_PATHS = [
    r"D:\文档\deepseek-harness\default-workspace\mail-auth-code.txt",
    r"D:\文档\deepseek-harness\default-workspace\mail-auth-code.txt.txt",
    r"D:\文档\deepseek-harness\default-workspace\mail-auth-code",
    os.path.join(os.path.expanduser("~"), ".dsh", "mail163-auth-code.txt"),
    os.path.join(os.path.expanduser("~"), ".mail163-auth-code"),
]

# 面试/招聘相关关键词，用于默认筛选
DEFAULT_KEYWORDS = [
    "面试", "邀约", "笔试", "测评", "面试邀请", "面试通知",
    "一面", "二面", "三面", "终面", "offer", "应聘", "候选人", "interview",
]

ID_ARGS = '("name" "dsh-mail163" "version" "1.0" "vendor" "dsh" "contact" "none")'


def die(msg: str, code: int = 1):
    print(f"错误: {msg}", file=sys.stderr)
    sys.exit(code)


def load_code(code_file: str | None) -> str:
    """读取授权码。任何情况下都不打印其内容。"""
    env = os.environ.get("MAIL163_AUTH_CODE")
    if env and env.strip():
        print("授权码来源: 环境变量 MAIL163_AUTH_CODE", file=sys.stderr)
        return env.strip()

    cands = [code_file] if code_file else DEFAULT_CODE_PATHS
    for p in cands:
        if p and os.path.exists(p):
            with open(p, encoding="utf-8-sig") as f:
                c = f.read().strip()
            if c:
                print(f"授权码来源: {os.path.basename(p)} (长度 {len(c)})", file=sys.stderr)
                return c
    die(
        "未找到授权码。请设置环境变量 MAIL163_AUTH_CODE，"
        "或用 --code-file 指定，或把授权码写入以下任一位置:\n  "
        + "\n  ".join(DEFAULT_CODE_PATHS)
    )
    return ""  # unreachable


def connect(address: str, code: str) -> imaplib.IMAP4_SSL:
    try:
        M = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT, timeout=60)
    except Exception as e:
        die(f"无法连接 {IMAP_HOST}:{IMAP_PORT} — {e}")
    # 163 强制：登录前必须发 ID，否则 SELECT 报 "Unsafe Login"
    try:
        M.xatom("ID", ID_ARGS)
    except Exception:
        pass
    try:
        M.login(address, code)
    except imaplib.IMAP4.error as e:
        m = str(e)
        hint = ""
        if "550" in m or "permission" in m.lower():
            hint = (
                "\n提示: 550 类错误通常表示 163 账号未开启 IMAP/SMTP 服务，"
                "或授权码是在开启服务之前生成的（需在开启后重新生成）。"
            )
        elif "LOGIN" in m.upper():
            hint = "\n提示: 授权码错误，或使用了登录密码（必须用授权码）。"
        die(f"登录失败: {m}{hint}")
    return M


def decode_header(raw: str | None) -> str:
    if not raw:
        return ""
    out = []
    for chunk, enc in email.header.decode_header(raw):
        if isinstance(chunk, bytes):
            for e in (enc, "utf-8", "gb18030", "latin-1"):
                if not e:
                    continue
                try:
                    out.append(chunk.decode(e))
                    break
                except (UnicodeDecodeError, LookupError):
                    continue
            else:
                out.append(chunk.decode("utf-8", "replace"))
        else:
            out.append(chunk)
    return "".join(out).strip()


def body_text(msg: email.message.Message, limit: int = 50000) -> str:
    """提取纯文本正文；无 text/plain 时从 HTML 退化提取。"""
    txt, html = [], []
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            if "attachment" in str(part.get("Content-Disposition") or "").lower():
                continue
            if ctype not in ("text/plain", "text/html"):
                continue
            try:
                payload = part.get_payload(decode=True)
                if not payload:
                    continue
                cs = part.get_content_charset() or "utf-8"
                try:
                    s = payload.decode(cs, "replace")
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
        for a, b in (("&nbsp;?", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">")):
            out = re.sub(a, b, out)
        out = re.sub(r"[ \t]{2,}", " ", out)
        out = re.sub(r"\n{3,}", "\n\n", out)
    return out[:limit]


def extract_attachments(msg: email.message.Message) -> list[dict]:
    out = []
    if not msg.is_multipart():
        return out
    for part in msg.walk():
        if "attachment" not in str(part.get("Content-Disposition") or "").lower():
            continue
        out.append({
            "filename": decode_header(part.get_filename()),
            "content_type": part.get_content_type(),
            "size": len(part.get_payload(decode=True) or b""),
        })
    return out


def _decode_mutf7(name: str) -> str:
    """解码 IMAP modified UTF-7（文件夹名的 '&XfJT0ZAB-' 形式）。

    规则：`&` 起始、`-` 结束的段是 modified BASE64（其中 ',' 代替 '/'），
    内容按 UTF-16BE 解码；单独的 `&-` 表示字面量 '&'。
    """
    import base64

    def rep(m: re.Match) -> str:
        s = m.group(1)
        if s == "":
            return "&"
        b = s.replace(",", "/")
        b += "=" * (-len(b) % 4)
        try:
            return base64.b64decode(b).decode("utf-16-be")
        except Exception:
            return "&" + s + "-"

    return re.sub(r"&([A-Za-z0-9,+\-]*?)-", rep, name)


def cmd_folders(args):
    M = connect(args.address, load_code(args.code_file))
    typ, boxes = M.list()
    print(f"{'原始名':<22} 解码后")
    print("-" * 60)
    for b in boxes or []:
        s = b.decode("utf-8", "ignore") if isinstance(b, bytes) else str(b)
        m = re.search(r'"([^"]*)"\s*$', s)
        raw = m.group(1) if m else s
        flags = re.match(r"\(([^)]*)\)", s)
        fl = flags.group(1) if flags else ""
        print(f"{raw:<22} {_decode_mutf7(raw):<20} [{fl}]")
    M.logout()


def _fetch(args) -> list[dict]:
    M = connect(args.address, load_code(args.code_file))
    folder = args.folder
    typ, dat = M.select(folder, readonly=True)
    if typ != "OK":
        die(f"无法打开文件夹 {folder}: {dat}")

    since = (datetime.date.today() - datetime.timedelta(days=args.days)).strftime("%d-%b-%Y")
    typ, dat = M.search(None, f'(SINCE "{since}")')
    if typ != "OK":
        die(f"搜索失败: {dat}")
    ids = dat[0].split()
    print(f"文件夹 {folder}: 近 {args.days} 天共 {len(ids)} 封 (SINCE {since})", file=sys.stderr)

    kws = args.keyword or DEFAULT_KEYWORDS
    recs = []
    for num in ids:
        try:
            typ, data = M.fetch(num, "(RFC822)")
            if typ != "OK" or not data or not isinstance(data[0], tuple):
                continue
            msg = email.message_from_bytes(data[0][1])
            subject = decode_header(msg.get("Subject"))
            from_ = decode_header(msg.get("From"))
            body = body_text(msg)
            try:
                dt = parsedate_to_datetime(msg.get("Date") or "")
                date_str = dt.astimezone().strftime("%Y-%m-%d %H:%M")
            except Exception:
                date_str = msg.get("Date") or ""
            rec = {
                "date": date_str,
                "from": from_,
                "to": decode_header(msg.get("To")),
                "subject": subject,
                "message_id": (msg.get("Message-ID") or "").strip(),
                "attachments": extract_attachments(msg),
            }
            if args.keep_body:
                rec["body"] = body
            else:
                rec["body_excerpt"] = body[:800]
            # 关键词命中标记
            hay = (subject + " " + from_ + " " + body[:5000]).lower()
            rec["matched"] = [k for k in kws if k.lower() in hay]
            recs.append(rec)
        except Exception as e:
            print(f"  解析失败 {num!r}: {e}", file=sys.stderr)
    M.logout()
    recs.sort(key=lambda r: r["date"], reverse=True)
    return recs


def cmd_fetch(args):
    recs = _fetch(args)
    hit = [r for r in recs if r["matched"]]
    if args.only_matched:
        recs = hit
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            for r in recs:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"已写入 {len(recs)} 封 -> {args.out}", file=sys.stderr)
    else:
        for r in recs:
            print(json.dumps(r, ensure_ascii=False))
    print(
        f"\n合计 {len(recs)} 封，其中含关键词 {len(hit)} 封",
        file=sys.stderr,
    )


def cmd_digest(args):
    recs = _fetch(args)
    hit = [r for r in recs if r["matched"]]
    print(f"{'日期':<17} {'命中':<5} 主题 / 发件人")
    print("-" * 100)
    for r in recs:
        flag = "★" if r["matched"] else " "
        print(f"{r['date']:<17} {flag:<5} {r['subject'][:56]}")
        print(f"{'':<17} {'':<5}   {r['from'][:80]}")
    print("-" * 100)
    print(f"共 {len(recs)} 封，命中面试/招聘关键词 {len(hit)} 封")


def main():
    ap = argparse.ArgumentParser(description="网易 163 邮箱 IMAP 读取工具")
    ap.add_argument("--address", default=DEFAULT_ADDRESS, help="邮箱地址")
    ap.add_argument("--code-file", help="授权码文件路径")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("folders", help="列出邮箱文件夹")
    p.set_defaults(func=cmd_folders)

    for name, fn, helptext in (
        ("fetch", cmd_fetch, "拉取邮件并输出 NDJSON"),
        ("digest", cmd_digest, "只输出摘要表"),
    ):
        p = sub.add_parser(name, help=helptext)
        p.add_argument("--days", type=int, default=7, help="回溯天数（默认 7）")
        p.add_argument("--folder", default="INBOX", help="文件夹（默认 INBOX）")
        p.add_argument("--keyword", action="append", help="关键词（可重复）")
        p.add_argument("--out", help="输出文件（NDJSON）；不指定则打印到 stdout")
        p.add_argument("--keep-body", action="store_true", help="保留完整正文")
        p.add_argument("--only-matched", action="store_true", help="只输出命中关键词的邮件")
        p.set_defaults(func=fn)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
