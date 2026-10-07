"""精确定位 163 鉴权失败原因：用户名格式 + 密码类型 + 新鲜度"""
import imaplib
import os
import smtplib

WS = r"D:\文档\deepseek-harness\default-workspace"
CANDIDATES = ["mail-auth-code.txt", "mail-auth-code.txt.txt", "mail-auth-code"]
CODE_FILE = next(
    (os.path.join(WS, n) for n in CANDIDATES if os.path.exists(os.path.join(WS, n))), None
)
with open(CODE_FILE, encoding="utf-8") as f:
    code = f.read().strip()

st = os.stat(CODE_FILE)
import datetime

print("=" * 72)
print("文件信息")
print("=" * 72)
print(f"  文件: {os.path.basename(CODE_FILE)}")
print(f"  修改时间: {datetime.datetime.fromtimestamp(st.st_mtime):%Y-%m-%d %H:%M:%S}")
print(f"  授权码长度: {len(code)}")

# 用户名候选：完整地址 / 纯用户名
USERS = ["jay020513@163.com", "jay020513"]

print()
print("=" * 72)
print("SMTP 鉴权：对比不同用户名格式")
print("=" * 72)
for u in USERS:
    try:
        s = smtplib.SMTP_SSL("smtp.163.com", 465, timeout=30)
        s.login(u, code)
        print(f"  ✅ {u} -> 成功")
        s.quit()
    except smtplib.SMTPAuthenticationError as e:
        print(f"  ❌ {u} -> {e.smtp_code} {e.smtp_error!r}")
    except Exception as e:
        print(f"  ⚠️  {u} -> {type(e).__name__}: {e}")

print()
print("=" * 72)
print("IMAP 鉴权：对比不同用户名格式")
print("=" * 72)
for u in USERS:
    try:
        M = imaplib.IMAP4_SSL("imap.163.com", 993, timeout=30)
        M.xatom("ID", '("name" "dsh" "version" "1.0" "vendor" "dsh" "contact" "none")')
        M.login(u, code)
        print(f"  ✅ {u} -> 成功")
        M.logout()
    except imaplib.IMAP4.error as e:
        print(f"  ❌ {u} -> {e}")
    except Exception as e:
        print(f"  ⚠️  {u} -> {type(e).__name__}: {e}")

print()
print("=" * 72)
print("CAPABILITY（看服务器支持哪些认证机制）")
print("=" * 72)
try:
    M = imaplib.IMAP4_SSL("imap.163.com", 993, timeout=30)
    typ, dat = M.capability()
    print(f"  {typ}: {dat}")
    M.logout()
except Exception as e:
    print(f"  ⚠️ {e}")
