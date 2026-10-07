import json, ssl, urllib.request, time

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
        return None, str(e)[:100]

# 已知的候选仓库，直接检查是否存在（不消耗搜索配额）
candidates = {
    "dsh-message-edit": ["Anionex/dsh-message-edit", "omdsh-dev/dsh-message-edit"],
    "dsh-agent-teams":  ["Anionex/dsh-agent-teams", "omdsh-dev/dsh-agent-teams"],
    "dsh-memory-evolve":["Anionex/dsh-memory-evolve", "omdsh-dev/dsh-memory-evolve"],
    "dsh-llm-fallbacks":["Anionex/dsh-llm-fallbacks", "omdsh-dev/dsh-llm-fallbacks"],
    "dsh-feishu-bot":   ["omdsh-dev/dsh-feishu-bot", "Anionex/dsh-feishu-bot"],
    "ModLens":          ["omdsh-dev/ModLens", "Anionex/ModLens"],
}

print("=== 用 topic 列表核对（一次请求拿 100 个）===")
code, data = get("https://api.github.com/search/repositories?q=topic:dsh-plugin&per_page=100&sort=stars")
topic_names = set()
if code == 200:
    for it in data.get("items", []):
        topic_names.add(it["full_name"].lower())
        topic_names.add(it["name"].lower())
    print(f"  拿到 {len(data.get('items', []))} 个仓库样本，total={data.get('total_count')}")

targets = ["modlens","dsh-at-file","dsh-paste-input","dsh-office","dsh-browser-panel",
           "dsh-computer-use","safe-find-dsh-plugins","dsh-web-ui","dsh-genui",
           "dsh-turn-rewind","dsh-message-edit","dsh-agent-teams","dsh-memory-evolve",
           "dsh-llm-fallbacks","dsh-feishu-bot"]

print("\n=== 这 15 个名字是否出现在 topic:dsh-plugin 的仓库中 ===")
for t in targets:
    hit = [n for n in topic_names if t in n]
    print(f"  {'✅' if hit else '❌'} {t:26} {hit[:2]}")

print("\n=== 逐个直接验证候选仓库是否存在 ===")
for name, repos in candidates.items():
    found = False
    for r in repos:
        code, data = get(f"https://api.github.com/repos/{r}")
        if code == 200:
            print(f"  ✅ {name:20} -> {data['full_name']}  stars={data.get('stargazers_count')}  desc={(data.get('description') or '')[:60]}")
            found = True
            break
        time.sleep(0.6)
    if not found:
        print(f"  ❓ {name:20} 候选仓库均未命中（可能名字不同）")
