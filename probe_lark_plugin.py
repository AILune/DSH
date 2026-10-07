import urllib.request, ssl, json, base64

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
UA = {"User-Agent": "Mozilla/5.0", "Accept": "application/vnd.github+json"}


def raw(path):
    u = f"https://raw.githubusercontent.com/omdsh-dev/dsh-lark/main/{path}"
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=25, context=ctx)
        return r.read().decode("utf-8", "ignore")
    except Exception as e:
        return f"__ERR__ {e}"


print("=" * 72)
print("A. cordis.patch.yml —— 它往插件树里插了什么")
print("=" * 72)
print(raw("cordis.patch.yml"))

print()
print("=" * 72)
print("B. SECURITY.md")
print("=" * 72)
print(raw("SECURITY.md"))

print()
print("=" * 72)
print("C. src 目录")
print("=" * 72)
try:
    r = urllib.request.urlopen(
        urllib.request.Request("https://api.github.com/repos/omdsh-dev/dsh-lark/contents/src",
                               headers=UA), timeout=25, context=ctx)
    for x in json.loads(r.read().decode("utf-8", "ignore")):
        print(f"  {x['type']:5} {x['name']:40} {x.get('size', 0):>9,} B")
except Exception as e:
    print(" ERR", e)
