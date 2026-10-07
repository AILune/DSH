import urllib.request, ssl, re

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
UA = {"User-Agent": "Mozilla/5.0"}


def get(u):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30, context=ctx)
        return r.getcode(), r.read().decode("utf-8", "ignore")
    except Exception as e:
        return None, str(e)


c, b = get("https://raw.githubusercontent.com/larksuite/cli/main/README.md")
print("README len:", len(b) if b else 0)
print("=" * 74)
if c and not b.startswith("__ERR__"):
    # 找安装 / 配置 / 权限 章节
    for kw in ["install", "Install", "config init", "auth login", "permission", "Permission",
               "Skill", "skill", "prerequisite", "Prerequisite", "Requirement", "requirement"]:
        for m in re.finditer(r"^.*" + re.escape(kw) + r".*$", b, re.M):
            line = m.group(0).strip()
            if len(line) > 3:
                print(f"  {line[:165]}")
                break
    print()
    print("---- 前 3000 字符 ----")
    print(b[:3000])
else:
    print(str(b)[:300])
