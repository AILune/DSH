import urllib.request, ssl, json, urllib.parse

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
UA = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}


def reg(name):
    u = "https://registry.npmjs.org/" + urllib.parse.quote(name, safe="@")
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30, context=ctx)
        return json.loads(r.read().decode("utf-8", "ignore"))
    except Exception as e:
        return {"__err__": str(e)}


for name in ["@larksuite/cli", "skills"]:
    d = reg(name)
    print("=" * 70)
    print(f"包: {name}")
    if "__err__" in d:
        print("  ERR:", d["__err__"])
        continue
    latest = d.get("dist-tags", {}).get("latest")
    v = d.get("versions", {}).get(latest, {})
    print(f"  latest      : {latest}")
    print(f"  description : {d.get('description','')[:180]}")
    print(f"  发布时间    : {d.get('time', {}).get(latest)}")
    print(f"  license     : {v.get('license')}")
    print(f"  bin         : {json.dumps(v.get('bin'), ensure_ascii=False)}")
    print(f"  engines     : {json.dumps(v.get('engines', {}), ensure_ascii=False)}")
    print(f"  repository  : {json.dumps(v.get('repository'), ensure_ascii=False)[:160]}")
    print(f"  维护者      : {[m.get('name') for m in d.get('maintainers', [])]}")
    print(f"  版本总数    : {len(d.get('versions', {}))}")
