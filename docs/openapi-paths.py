#!/usr/bin/env python3
"""openapi-paths — kiterunner 式上下文感知路径生成
从 openapi.json/swagger.json 生成候选测试路径(比盲扫快 10 倍)
用法: openapi-paths.py --spec http://target/openapi.json [--base /api]
      openapi-paths.py --file openapi.json
"""
import sys, json, argparse, urllib.request

def fetch_spec(url):
    ctx = __import__('ssl').create_default_context()
    ctx.check_hostname = False; ctx.verify_mode = __import__('ssl').CERT_NONE
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=15, context=ctx))

def extract_paths(spec, base=''):
    """提取所有路径+方法+参数"""
    results = []
    paths = spec.get('paths', {})
    for path, methods in paths.items():
        full = base + path
        for method, detail in methods.items():
            if method not in ('get', 'post', 'put', 'patch', 'delete', 'head', 'options'):
                continue
            entry = {'path': full, 'method': method.upper(),
                     'summary': detail.get('summary', detail.get('description', '')[:60]),
                     'params': [], 'auth': bool(detail.get('security'))}
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
    # 猜测隐藏路径(openapi 里常见 deleted/hidden 但实现仍在)
    for path in paths:
        for guess in ['{id}', '{id}/detail', '{id}/export', '{id}/admin', 'all', 'list', 'search']:
            results.append({'path': base + path + '/' + guess, 'method': 'GET',
                           'summary': '(guessed sibling)', 'params': [], 'auth': False})
    return results

def gen_test_cases(paths):
    """从路径生成测试用例——IDOR/越权/注入锚点"""
    cases = []
    for p in paths:
        # 有 {id} 参数的→IDOR 测试点
        if '{id}' in p['path'] or any(pr['in'] == 'path' for pr in p['params']):
            cases.append({'test': 'idor', 'path': p['path'], 'method': p['method'],
                         'hint': '替换 {id} 为其他用户/顺序 ID'})
        # POST/PUT/PATCH→越权/参数篡改
        if p['method'] in ('POST', 'PUT', 'PATCH'):
            cases.append({'test': 'mass-assignment', 'path': p['path'], 'method': p['method'],
                         'hint': '注入 role/is_admin/status/balance 字段'})
        # 无 auth 标记的敏感方法
        if not p['auth'] and p['method'] in ('GET', 'DELETE') and any(k in p['path'].lower() for k in ('user', 'admin', 'internal', 'debug', 'config', 'secret', 'key', 'token')):
            cases.append({'test': 'unauth-sensitive', 'path': p['path'], 'method': p['method'],
                         'hint': '未标记 security 的敏感端点'})
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
            auth = '🔒' if p['auth'] else '  '
            print(f'{auth} {p["method"]:>7} {p["path"]}  # {p["summary"][:40]}')
        print(f'\n== {len(cases)} test cases(IDOR/越权/未授权) ==')
        for c in cases[:20]:
            print(f'  [{c["test"]}] {c["method"]} {c["path"]}')
            print(f'     → {c["hint"]}')
