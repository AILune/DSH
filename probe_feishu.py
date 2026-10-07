import urllib.request, ssl, re

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def get(url):
    try:
        req = urllib.request.Request(url, headers=UA)
        r = urllib.request.urlopen(req, timeout=25, context=ctx)
        return r.getcode(), r.read().decode("utf-8", "ignore")
    except Exception as e:
        return None, str(e)


c, b = get("https://open.feishu.cn/document/server-docs/api-call-guide/terminology.md")
print("=" * 72)
print("术语表（找 App ID / App Secret 定义）")
print("=" * 72)
print(b[:2600] if c == 200 else b)
