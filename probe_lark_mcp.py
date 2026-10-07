import urllib.request, ssl, re

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
UA = {"User-Agent": "Mozilla/5.0"}


def raw(f):
    u = f"https://raw.githubusercontent.com/larksuite/lark-openapi-mcp/main/{f}"
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30, context=ctx)
        return r.read().decode("utf-8", "ignore")
    except Exception as e:
        return f"__ERR__ {e}"


presets = raw("docs/reference/tool-presets/presets.md")
print("presets.md 长度:", len(presets))
print("=" * 74)
# 找所有 preset 名字
names = re.findall(r"^\s*[-*]?\s*`?(preset\.[a-z0-9._]+)`?", presets, re.M)
print("preset 列表:", sorted(set(names)))
print()
# 找 docx / wiki / doc 相关
for kw in ["docx", "wiki", "doc.", "drive", "sheet"]:
    print(f"--- 含 {kw!r} 的行 ---")
    for line in presets.split("\n"):
        if kw in line.lower():
            print("   ", line.strip()[:150])

print()
print("=" * 74)
tools = raw("docs/reference/tool-presets/tools-en.md")
print("tools-en.md 长度:", len(tools))
if not tools.startswith("__ERR__"):
    for kw in ["docx", "wiki"]:
        hits = [l.strip() for l in tools.split("\n") if kw in l.lower()]
        print(f"\n--- tools-en.md 中 {kw!r} 相关（{len(hits)} 行）---")
        for h in hits[:25]:
            print("   ", h[:160])
