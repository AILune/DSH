import urllib.request, ssl, os, tarfile, io, json

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
UA = {"User-Agent": "Mozilla/5.0"}

WS = r"D:\文档\deepseek-harness\default-workspace"
DEST = os.path.join(WS, "lark-cli-repo")
os.makedirs(DEST, exist_ok=True)

url = "https://codeload.github.com/larksuite/cli/tar.gz/refs/heads/main"
print("下载:", url)
req = urllib.request.Request(url, headers=UA)
data = urllib.request.urlopen(req, timeout=180, context=ctx).read()
print(f"  下载完成: {len(data):,} 字节")

tf = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")
members = tf.getmembers()
print(f"  归档条目: {len(members)}")

# 只解出 skills/ 目录和 README，避免整仓解包
top = members[0].name.split("/")[0]
print(f"  顶层目录: {top}")
want = [m for m in members if "/skills/" in m.name or m.name.endswith("README.md")]
print(f"  匹配 skills/ 与 README 的条目: {len(want)}")

for m in want:
    rel = m.name[len(top) + 1:] if m.name.startswith(top + "/") else m.name
    if not rel or rel.startswith("/") or ".." in rel:
        continue
    target = os.path.join(DEST, rel)
    if m.isdir():
        os.makedirs(target, exist_ok=True)
    elif m.isfile():
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as f:
            f.write(tf.extractfile(m).read())
tf.close()

print("\n=== skills/ 目录结构 ===")
sk = os.path.join(DEST, "skills")
if os.path.isdir(sk):
    for name in sorted(os.listdir(sk)):
        p = os.path.join(sk, name)
        if os.path.isdir(p):
            inner = sorted(os.listdir(p))
            has_skill_md = "SKILL.md" in inner
            print(f"  📁 {name:32} {'✅ SKILL.md' if has_skill_md else ''}  内含 {len(inner)} 项")
        else:
            print(f"  📄 {name}")
else:
    print("  未找到 skills/ 目录")
    print("  实际顶层内容:", sorted(os.listdir(DEST))[:20])
