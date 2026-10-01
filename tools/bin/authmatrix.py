#!/usr/bin/env python3
"""authmatrix — 鉴权矩阵执行器:N 身份 × M 端点重放 + 四态初判。
记账:内置预算账本(HTTPQ_DIR/ledger.tsv + HTTPQ_BUDGET, 历史上与 httpq.sh
同口径; 该 shell 工具已不在交付面——CS23-N7 后口径由本工具自带)。
预算耗尽即拒(HTTPQ_BUDGET,默认 600)。响应体全量存档 resp_<n>.json,
供 jsondiff.py 做字段级 PPOR 判定。

输入(json):
{
  "base": "http://172.28.0.11:18090",
  "identities": {"anon": null, "alice": "TOK_A", "bob": "TOK_B"},
  "endpoints": [
    {"label": "orders-detail", "method": "GET", "path": "/api/orders/1003"},
    {"label": "admin-reset", "method": "POST", "path": "/api/admin/users/2/reset-password"}
  ]
}
用法: authmatrix.py plan.json
"""
import sys, os, json, time, urllib.request, urllib.error

SENSITIVE = ('password', 'hash', 'idcard', 'sfzh', 'salary', 'phone',
             'secret', 'paypassword', 'token', 'apikey', 'api_key')

def ledger(label, code, dt, body_path):
    """预算记账口径: ledger.tsv + count, 超预算即拒(单一预算)。"""
    d = os.environ.get('HTTPQ_DIR', '/tmp/httpq')
    budget = int(os.environ.get('HTTPQ_BUDGET', '600'))
    os.makedirs(d, exist_ok=True)
    n = 0
    cf = os.path.join(d, 'count')
    if os.path.exists(cf):
        n = int(open(cf).read().strip() or 0)
    if n >= budget:
        print(f'authmatrix: BUDGET EXHAUSTED ({n}/{budget}) — cell [{label}] skipped', file=sys.stderr)
        return None, n + 1
    with open(os.path.join(d, 'ledger.tsv'), 'a') as f:
        f.write(f"{n+1}\t{label}\t{code}\t{dt:.3f}s\t{body_path}\n")
    with open(cf, 'w') as f:
        f.write(str(n + 1))
    return n + 1, n + 1

def main():
    # R32D41-N2: 此前 --help/无参均裸栈(FileNotFoundError/IndexError)。
    if len(sys.argv) != 2 or sys.argv[1] in ('-h', '--help'):
        print(__doc__)
        return 2 if len(sys.argv) != 2 else 0
    try:
        plan = json.load(open(sys.argv[1]))
    except (OSError, ValueError) as e:
        print(f'[authmatrix] 读取计划失败: {e}', file=sys.stderr); return 2
    base, ids, eps = plan['base'], plan['identities'], plan['endpoints']
    d = os.environ.get('HTTPQ_DIR', '/tmp/httpq')
    os.makedirs(d, exist_ok=True)
    results = {}
    for iname, tok in ids.items():
        for ep in eps:
            req = urllib.request.Request(base + ep['path'], method=ep.get('method', 'GET'))
            if tok:
                req.add_header('Authorization', f'Bearer {tok}')
            body = None
            if ep.get('method', 'GET') in ('POST', 'PUT', 'PATCH'):
                req.add_header('Content-Type', 'application/json')
                body = ep.get('body', '{}').encode()
            t0 = time.time()
            try:
                r = urllib.request.urlopen(req, body, timeout=15)
                code, data = r.status, r.read().decode(errors='replace')
            except urllib.error.HTTPError as e:
                code, data = e.code, e.read().decode(errors='replace')
            except Exception as e:
                code, data = 0, str(e)
            dt = time.time() - t0
            # 记账(单一口径),随后全量存档响应体
            n, _ = ledger(f'{iname}:{ep["label"]}', code, dt, f'{d}/resp_am_{iname}_{ep["label"]}.json')
            if n is None:
                continue
            safe = f'{d}/resp_am_{iname}_{ep["label"]}.json'
            with open(safe, 'w') as f:
                f.write(data)
            results[(iname, ep['label'])] = (code, data)
            print(f'[{n}/{os.environ.get("HTTPQ_BUDGET","600")}] {iname:8} {ep["label"]:20} {code}  {data[:70]}')
    print('\n== 四态初判 ==')
    for ep in eps:
        col = {i: results.get((i, ep['label']), (0, '')) for i in ids}
        codes = {i: c for i, (c, _) in col.items()}
        if codes.get('anon') == 200 and any(codes.get(u) == 200 for u in ids if u != 'anon'):
            print(f'[漏鉴权候选] {ep["label"]}: 未登录 200+数据')
        for i, (c, txt) in col.items():
            low = txt.lower()
            if c == 200 and any(s in low for s in SENSITIVE):
                print(f'[PPOR 候选] {ep["label"]} @ {i}: 响应含敏感字段 → jsondiff 对照其它身份存档')
                break
        if codes.get('anon') in (401, 403) and any(codes.get(u) == 200 for u in ids if u != 'anon'):
            print(f'[BOLA/BFLA 需对照] {ep["label"]}: 低权 200 / anon {codes["anon"]} — 属主/角色核对')
    print(f'\n存档: {d}/resp_am_*.json — jsondiff.py <a> <b> 出字段级差异')
    return 0

if __name__ == '__main__':
    sys.exit(main())
