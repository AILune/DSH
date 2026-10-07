"""163 邮箱 IMAP 连通性与目录探测。
授权码从工作区文件读取，全程不打印其值。
"""
import imaplib
import os
import re
import sys

WS = r"D:\文档\deepseek-harness\default-workspace"
ADDR = "jay020513@163.com"

# 记事本可能把文件名存成 xxx.txt.txt，两种都接受
CANDIDATES = ["mail-auth-code.txt", "mail-auth-code.txt.txt", "mail-auth-code"]
CODE_FILE = next(
    (os.path.join(WS, n) for n in CANDIDATES if os.path.exists(os.path.join(WS, n))),
    None,
)
if CODE_FILE is None:
    print("❌ 未找到授权码文件，尝试过:")
    for n in CANDIDATES:
        print(f"   {os.path.join(WS, n)}")
    sys.exit(2)
print(f"使用授权码文件: {os.path.basename(CODE_FILE)}")

# 读取授权码 —— 只取长度，绝不打印内容
with open(CODE_FILE, encoding="utf-8") as f:
    code = f.read().strip()
if not code:
    print("❌ 授权码文件为空")
    sys.exit(2)
print(f"✅ 已读取授权码: 长度 {len(code)} 字符，含空格={(' ' in code)}")
print(f"   账号: {ADDR}")

# 连接
print("\n[1] 连接 imap.163.com:993 ...")
try:
    M = imaplib.IMAP4_SSL("imap.163.com", 993, timeout=30)
except Exception as e:
    print(f"❌ 连接失败: {e}")
    sys.exit(1)

# 163 要求登录后发送 ID 命令，否则 SELECT 会报 "Unsafe Login"
print("[2] 发送 ID 命令（163 必需，否则 SELECT 报 Unsafe Login）...")
try:
    args = ('("name" "dsh" "version" "1.0" "vendor" "dsh-agent" '
            '"contact" "none")')
    typ, dat = M.xatom("ID", args)
    print(f"    ID 响应: {typ}")
except Exception as e:
    print(f"    ID 命令异常（可忽略）: {e}")

# 登录
print("[3] 登录 ...")
try:
    M.login(ADDR, code)
    print("    ✅ 登录成功")
except imaplib.IMAP4.error as e:
    msg = str(e)
    print(f"    ❌ 登录失败: {msg}")
    if "AUTHENTICATIONFAILED" in msg.upper() or "LOGIN" in msg.upper():
        print("    可能原因：授权码错误 / 未开启 IMAP 服务 / 用错了登录密码（必须是授权码）")
    sys.exit(1)

# 列目录
print("\n[4] 邮箱目录列表:")
try:
    typ, boxes = M.list()
    for b in boxes:
        s = b.decode("utf-8", "ignore") if isinstance(b, bytes) else str(b)
        print("    ", s)
except Exception as e:
    print(f"    ❌ 列目录失败: {e}")

# 收件箱状态
print("\n[5] 收件箱（INBOX）状态:")
try:
    typ, dat = M.select("INBOX", readonly=True)
    print(f"    SELECT -> {typ}, 邮件总数 = {dat[0].decode() if dat and dat[0] else '?'}")
except Exception as e:
    print(f"    ❌ SELECT 失败: {e}")

try:
    M.logout()
    print("\n[6] 已断开连接")
except Exception:
    pass
print("\n✅ 连通性测试完成")
