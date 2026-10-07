import urllib.request, ssl, json

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
UA = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}


def get(u):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=25, context=ctx)
        return r.getcode(), dict(r.headers), r.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8", "ignore")
    except Exception as e:
        return None, {}, str(e)


AS = "https://accounts.feishu.cn/mcp"
print("=" * 74)
print("授权服务器元数据")
print("=" * 74)
for u in [
    AS + "/.well-known/oauth-authorization-server",
    AS + "/.well-known/openid-configuration",
    "https://accounts.feishu.cn/.well-known/oauth-authorization-server",
]:
    c, h, b = get(u)
    print(f"\n  {u}\n    HTTP = {c}")
    try:
        d = json.loads(b)
        for k in ["issuer", "authorization_endpoint", "token_endpoint",
                  "registration_endpoint", "scopes_supported",
                  "code_challenge_methods_supported", "grant_types_supported",
                  "response_types_supported"]:
            if k in d:
                v = d[k]
                if isinstance(v, list):
                    print(f"      {k}: {v if len(v) < 12 else str(v[:12]) + ' ...'}")
                else:
                    print(f"      {k}: {v}")
        extra = set(d) - {"issuer", "authorization_endpoint", "token_endpoint",
                          "registration_endpoint", "scopes_supported",
                          "code_challenge_methods_supported", "grant_types_supported",
                          "response_types_supported"}
        if extra:
            print(f"      其他字段: {sorted(extra)}")
    except Exception:
        print(f"    body = {b[:200]!r}")
