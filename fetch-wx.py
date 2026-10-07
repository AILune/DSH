import urllib.request, ssl, re, sys, html

URL = "https://mp.weixin.qq.com/s/x3e7df6m9GvKW8bJeZY8NQ"
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

UAS = [
    ("WeChat-mobile", "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40(0x18002832) NetType/WIFI Language/zh_CN"),
    ("WeChat-desktop", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20"),
    ("Chrome", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"),
]

for label, ua in UAS:
    req = urllib.request.Request(URL, headers={
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": "https://mp.weixin.qq.com/",
    })
    try:
        r = urllib.request.urlopen(req, timeout=30, context=ctx)
        raw = r.read()
        text = raw.decode("utf-8", "ignore")
        print(f"--- {label}: HTTP {r.getcode()}  len={len(raw)}  final={r.geturl()[:90]}")
        # 判断是否被拦
        if "环境异常" in text or "wappoc_appmsgcaptcha" in r.geturl() or "verify" in r.geturl():
            print("    ⚠️ 被验证页拦截")
            continue
        # 提取标题
        m = re.search(r'<meta property="og:title" content="([^"]*)"', text) or re.search(r"<title>([^<]*)</title>", text)
        if m:
            print("    标题:", html.unescape(m.group(1))[:120])
        # 提取正文
        body = re.search(r'<div class="rich_media_content[^"]*"[^>]*>(.*?)</div>\s*</div>', text, re.S)
        if not body:
            body = re.search(r'id="js_content"[^>]*>(.*?)</div>', text, re.S)
        if body:
            content = body.group(1)
            content = re.sub(r"<script.*?</script>", "", content, flags=re.S)
            content = re.sub(r"<style.*?</style>", "", content, flags=re.S)
            content = re.sub(r"<br\s*/?>", "\n", content)
            content = re.sub(r"</p>|</section>|</li>|</h\d>", "\n", content)
            content = re.sub(r"<[^>]+>", "", content)
            content = html.unescape(content)
            content = re.sub(r"\n{3,}", "\n\n", content).strip()
            print(f"    正文长度: {len(content)}")
            with open(r"D:\文档\deepseek-harness\default-workspace\wx-article.txt", "w", encoding="utf-8") as f:
                f.write(content)
            print("    已保存 -> wx-article.txt")
            print("    前 500 字:")
            print("   ", content[:500].replace("\n", "\n    "))
            sys.exit(0)
        else:
            print("    未找到正文容器")
    except Exception as e:
        print(f"--- {label}: 失败 {str(e)[:100]}")

print("\n全部尝试失败或被拦截")
sys.exit(1)
