import json, ssl, urllib.request, urllib.parse

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def get(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
        "Accept": "application/vnd.github+json",
    })
    try:
        r = urllib.request.urlopen(req, timeout=25, context=ctx)
        return r.getcode(), json.loads(r.read().decode("utf-8", "ignore"))
    except Exception as e:
        return None, str(e)[:120]

print("=== ① 文章声称的插件索引 https://github.com/topics/dsh-plugin ===")
code, data = get("https://api.github.com/search/repositories?q=topic:dsh-plugin&per_page=1")
if code == 200:
    print("  HTTP 200, total_count =", data.get("total_count"))
    print("  → 文章说'已收录 1000+ 插件'，实际:", "吻合" if data.get("total_count", 0) >= 1000 else f"不符（实际 {data.get('total_count')}）")
else:
    print("  查询失败:", data)

print("\n=== ② 逐名字全站搜仓库 ===")
namelist = [
    "dsh-at-file", "dsh-paste-input", "dsh-office", "dsh-browser-panel",
    "dsh-computer-use", "safe-find-dsh-plugins", "dsh-web-ui", "dsh-genui",
    "dsh-turn-rewind", "dsh-message-edit", "dsh-agent-teams",
    "dsh-memory-evolve", "dsh-llm-fallbacks", "dsh-feishu-bot", "ModLens",
]
for name in namelist:
    q = urllib.parse.quote(f'"{name}"')
    code, data = get(f"https://api.github.com/search/repositories?q={q}&per_page=3")
    if code == 200:
        n = data.get("total_count", 0)
        reps = [i["full_name"] for i in data.get("items", [])][:3]
        mark = "✅" if n > 0 else "❌"
        print(f"  {mark} {name:26} repos={n:<4} {reps}")
    else:
        print(f"  ⚠️ {name:26} 查询失败 {data}")
