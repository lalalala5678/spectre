#!/usr/bin/env python3
"""openapi-paths — kiterunner 式上下文感知路径生成
从 openapi.json/swagger.json 生成候选测试路径(比盲扫快 10 倍)
用法: openapi-paths.py --spec http://target/openapi.json [--base /api]
      openapi-paths.py --file openapi.json
"""
import sys, json, argparse, urllib.request

def fetch_spec(url):
    import ssl  # CS20-9: 静态直导入(PEP 8; 此前 __import__() 动态导入无理由)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=15, context=ctx))

def extract_paths(spec, base=''):
    """提取所有路径+方法+参数
    F32: 根级 security 继承——op 无 security 键时回退 spec 级全局;
    auth 三态: True=op显式鉴权 / None=显式公开(security:[]) / False=未知(继承全局但全局未声明)"""
    results = []
    paths = spec.get('paths', {})
    global_sec = spec.get('security')  # None=未声明; []=全局公开; [{...}]=全局鉴权
    for path, methods in paths.items():
        full = base + path
        for method, detail in methods.items():
            if method not in ('get', 'post', 'put', 'patch', 'delete', 'head', 'options'):
                continue
            # F32 三态 auth + 根级继承
            if 'security' in detail:
                op_sec = detail['security']
                auth = bool(op_sec) if op_sec else None  # []=显式公开
            elif global_sec:
                auth = True  # 继承全局鉴权
            elif global_sec == []:
                auth = None  # 继承全局公开
            else:
                auth = False  # 未知
            entry = {'path': full, 'method': method.upper(),
                     'summary': detail.get('summary', detail.get('description', '')[:60]),
                     'params': [], 'auth': auth}
            for p in detail.get('parameters', []):
                entry['params'].append({'name': p.get('name'), 'in': p.get('in'),
                                        'required': p.get('required', False),
                                        'type': p.get('schema', {}).get('type', 'string')})
            if 'requestBody' in detail:
                try:
                    content = detail['requestBody'].get('content', {})
                    for ct, spec_body in content.items():
                        if 'schema' in spec_body:
                            entry.setdefault('body_schema', {})[ct] = spec_body['schema']
                except Exception: pass
            results.append(entry)
    # 猜测隐藏路径(F32: 参数化路径不拼 /{id} 后缀——/api/users/{id}/{id}
    # 是垃圾;兄弟猜测挂集合根 /api/users/<guess>;非参数路径才拼 detail/export)
    seen_guess = set()
    for path in paths:
        parametrized = '{' in path
        # F45: 剥全部参数段(嵌套 /a/{id}/b/{x} → 集合根 /a/b)——
        # 此前仅剥最后一个 {..},父级字面量残留(/api/users/{id}/orders/all)
        import re as _re_g
        root = _re_g.sub(r'/\{[^}/]+\}(?=/|$)', '', path) if parametrized else path
        guesses = (['all', 'list', 'search', 'export', 'admin'] if parametrized
                   else ['{id}', 'detail', 'export', 'admin', 'all', 'list', 'search'])
        for guess in guesses:
            gp = base + root.rstrip('/') + '/' + guess
            if gp in seen_guess:
                continue  # F45: 去重(兄弟路径 5 条重复+签名撞车)
            seen_guess.add(gp)
            results.append({'path': gp, 'method': 'GET',
                           'summary': '(guessed sibling)', 'params': [], 'auth': False})
    return results

_SAMPLES = {'string': 'qa-probe', 'integer': '1'}

def _resolve_id(p):
    import re as _re
    return _re.sub(r'\{(\w+)\}', '1', p)

def _identity_matrix(path, method):
    """F46: 三身份可执行模板(unauth/低权/跨角色 curl 三行,铁律1 对照组)"""
    rp = _resolve_id(path)
    return {
        'exec': [
            {'identity': 'unauth', 'curl': 'curl -s -o /dev/null -w "%{http_code} %{size_download}" -X ' + method + ' "' + rp + '"'},
            {'identity': 'low-priv', 'curl': 'curl -s -o /dev/null -w "%{http_code} %{size_download}" -X ' + method + ' -H "Authorization: Bearer $LOW_TOKEN" "' + rp + '"'},
            {'identity': 'cross-user', 'curl': 'curl -s -o /dev/null -w "%{http_code} %{size_download}" -X ' + method + ' -H "Authorization: Bearer $OTHER_TOKEN" "' + rp + '"'},
        ],
        'verdict': '三身份状态码/长度差异即分级证据;同值=面等价(记录非漏洞)',
    }

def gen_test_cases(paths):
    """F45 去重 + F46 可执行三身份模板"""
    cases = []
    _sig = set()
    def _add(c):
        k = (c['test'], c['path'], c['method'])
        if k not in _sig:
            _sig.add(k)
            c['matrix'] = _identity_matrix(c['path'], c['method'])
            cases.append(c)
    for p in paths:
        # 有 {id} 参数的→IDOR 测试点
        if '{id}' in p['path'] or any(pr['in'] == 'path' for pr in p['params']):
            _add({'test': 'idor', 'path': p['path'], 'method': p['method'],
                         'hint': '替换 {id} 为其他用户/顺序 ID'})
        # POST/PUT/PATCH→越权/参数篡改
        if p['method'] in ('POST', 'PUT', 'PATCH'):
            _add({'test': 'mass-assignment', 'path': p['path'], 'method': p['method'],
                         'hint': '注入 role/is_admin/status/balance 字段'})
        # 无 auth 标记(显式公开/未知,非仅缺标记)的敏感方法
        if p['auth'] is not True and p['method'] in ('GET', 'DELETE') and any(k in p['path'].lower() for k in ('user', 'admin', 'internal', 'debug', 'config', 'secret', 'key', 'token')):
            label = 'explicit-public' if p['auth'] is None else 'unauth-sensitive'
            _add({'test': label, 'path': p['path'], 'method': p['method'],
                         'hint': '显式公开(security:[])的敏感端点——确认是否应公开' if p['auth'] is None else '未标记 security 的敏感端点'})
    return cases

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--spec', help='openapi.json URL')
    ap.add_argument('--file', help='本地 spec 文件')
    ap.add_argument('--base', default='')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    if not args.file and not args.spec:
        print(__doc__)
        sys.exit(2)
    spec = json.load(open(args.file)) if args.file else fetch_spec(args.spec)
    paths = extract_paths(spec, args.base)
    cases = gen_test_cases(paths)
    if args.json:
        print(json.dumps({'paths': paths, 'test_cases': cases}, indent=2, ensure_ascii=False))
    else:
        print(f'== {len(paths)} API paths ==')
        for p in paths[:30]:
            auth = '🔒' if p['auth'] is True else ('🆓' if p['auth'] is None else '❓')
            print(f'{auth} {p["method"]:>7} {p["path"]}  # {p["summary"][:40]}')
        print(f'\n== {len(cases)} test cases(IDOR/越权/未授权) ==')
        for c in cases[:20]:
            print(f'  [{c["test"]}] {c["method"]} {c["path"]}')
            print(f'     → {c["hint"]}')
