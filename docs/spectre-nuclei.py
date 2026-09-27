#!/usr/bin/env python3
"""spectre-nuclei — nuclei YAML 模板执行引擎(P0 借鉴)
兼容 nuclei 模板子集: id/info/matcher/extractor/requests[dns,http]/raw
直接执行社区 8000+ 模板,无需 Go 二进制。
用法:
  spectre-nuclei run --target http://x.com --templates /path/to/nuclei-templates/
  spectre-nuclei run --target http://x.com --template /path/to/cve.yaml
  spectre-nuclei list --templates /path/to/nuclei-templates/ --search weblogic
"""
import sys, os, json, re, argparse, hashlib, time
import yaml
import urllib.request, urllib.error
import socket
import ssl

# ============================================================
# 模板解析(nuclei YAML 子集)
# ============================================================

def load_template(path):
    with open(path) as f:
        return yaml.safe_load(f)

def list_templates(template_dir, search=None):
    """递归找所有 .yaml 模板"""
    found = []
    for root, dirs, files in os.walk(template_dir):
        for fn in files:
            if not fn.endswith(('.yaml', '.yml')):
                continue
            p = os.path.join(root, fn)
            try:
                t = load_template(p)
                if not t or 'id' not in t:
                    continue
                info = t.get('info', {})
                name = info.get('name', t['id'])
                sev = info.get('severity', 'unknown')
                tags = info.get('tags', '')
                if search:
                    s = search.lower()
                    if s not in str(t['id']).lower() and s not in name.lower() and s not in tags.lower():
                        continue
                found.append({'path': p, 'id': t['id'], 'name': name, 'severity': sev, 'tags': tags})
            except Exception:
                continue
    return found

# ============================================================
# HTTP 请求引擎
# ============================================================

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def do_http(req_spec, target):
    """执行模板中的一个 HTTP 请求 spec"""
    method = req_spec.get('method', 'GET').upper()
    path = req_spec.get('path', '/')
    headers = {k: str(v) for k, v in req_spec.get('headers', {}).items()}

    # path 可能是 str 或 list(nuclei 标准)——list 时取第一个(外部循环处理多 path)
    if isinstance(path, list):
        path = path[0] if path else '/'
    # 变量替换
    base = target.rstrip('/')
    root = '/'.join(base.split('/')[:3]) if '://' in base else base
    for var, val in [('{{BaseURL}}', base), ('{{RootURL}}', root),
                     ('{{Host}}', base.split('//')[1] if '//' in base else base),
                     ('{{scheme}}', base.split('://')[0] if '://' in base else 'http'),
                     ('{{port}}', base.split(':')[-1] if base.count(':') == 2 else '')]:
        path = path.replace(var, str(val))
    # F29: {{randstr}}/{{randstr_N}} 动态替换(字面量发出=必不命中)
    import random as _rnd, string as _str
    def _dyn(t):
        if not t:
            return t
        def _r(m):
            n = m.group(1)
            ln = int(n) if n and n.isdigit() else 8
            return ''.join(_rnd.choices(_str.ascii_lowercase, k=ln))
        import re as _re2
        return _re2.sub(r'\{\{randstr[_ ]?(\d+)?\}\}', _r, t)
    path = _dyn(path)
    # F37: payloads 变量系统——模板级 payloads: {var: val|(list|range)}
    # 代入 {{var}};全部替换后仍残留 {{...}} 的路径/体直接跳过
    # (字面量发出=必假阳性,php 组复扫 2 FP 实锤)。
    import re as _re3
    _pl = req_spec.get('payloads') or {}
    def _payloads_sub(txt):
        def _one(m):
            name = m.group(1)
            if name in _pl:
                v = _pl[name]
                if isinstance(v, list):
                    v = v[0] if v else ''
                return str(v)
            return m.group(0)
        return _re3.sub(r'\{\{(\w+)\}\}', _one, txt)
    path = _payloads_sub(path)
    if _re3.search(r'\{\{\w+\}\}', path):
        return 0, {}, b'__UNRESOLVED_VAR__'
    body = None
    if 'body' in req_spec:
        body = _payloads_sub(_dyn(str(req_spec['body']).replace('{{BaseURL}}', base)))
        headers.setdefault('Content-Type', 'application/x-www-form-urlencoded')

    url = path if path.startswith('http') else base + path
    # F29 出站围栏: 模板绝对 URL 只许打目标自身(OSINT 模板曾把内网
    # 扫描流量打到真实互联网)。
    try:
        from urllib.parse import urlsplit as _us
        _tu, _ru = _us(url), _us(base)
        if _tu.netloc and _ru.netloc and _tu.netloc != _ru.netloc:
            return 0, {}, b'__OUTBOUND_BLOCKED__'
    except Exception:
        pass

    req = urllib.request.Request(url, data=body.encode() if body else None, method=method)
    for k, v in headers.items():
        req.add_header(k, v)
    req.add_header('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')

    # F36: 重定向围栏——urlopen 默认跟随 302 且不复检(exploit PoC:
    # 302 跳第三方把请求带出围栏,自定义 Host 头随行)。每跳复检 netloc;
    # redirects:true 时同样受围栏约束,跨域跳转以 30x 状态返回。
    import urllib.request as _ur
    from urllib.parse import urlsplit as _us2
    _base_netloc = _us2(base).netloc
    class _FencedRedirect(_ur.HTTPRedirectHandler):
        def redirect_request(self, r2, fp, code, msg, headers, newurl):
            if _us2(newurl).netloc and _us2(newurl).netloc != _base_netloc:
                return None
            return super().redirect_request(r2, fp, code, msg, headers, newurl)
    try:
        opener = _ur.build_opener(_FencedRedirect, _ur.HTTPSHandler(context=ctx))
        resp = opener.open(req, timeout=10)
        return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()
    except Exception as e:
        return 0, {}, str(e).encode()

# ============================================================
# 匹配器(nuclei matchers 子集)
# ============================================================

def apply_matchers(matchers, status, headers, body):
    """执行 matchers——全部 AND 关系(nuclei 默认)"""
    # F29: internal:true 是条件匹配器,不构成最终命中——纯 internal 模板
    # 一律不判中(防"任何 200 服务器被报 critical RCE")。
    matchers = matchers or []
    if matchers and all(m.get("internal") for m in matchers):
        return False
    body_str = body.decode('utf-8', errors='replace')
    header_str = '\n'.join(f'{k}: {v}' for k, v in headers.items())
    results = []

    for m in matchers:
        if m.get('internal'):
            results.append(True)  # 条件器不参与最终判定
            continue
        mtype = m.get('type', '')
        mpart = m.get('part', 'body')  # body/header/all/response
        words = m.get('words', [])
        regex = m.get('regex', [])
        status_expected = m.get('status', [])
        condition = m.get('condition', 'or')

        if mpart == 'header':
            haystack = header_str
        elif mpart == 'all' or mpart == 'response':
            haystack = f'{status}\n{header_str}\n{body_str}'
        else:
            haystack = body_str

        matched = False
        if mtype == 'status':
            matched = status in (status_expected or [])
        elif mtype == 'word':
            if condition == 'and':
                matched = all(w.lower() in haystack.lower() for w in words)
            else:
                matched = any(w.lower() in haystack.lower() for w in words)
        elif mtype == 'regex':
            try:
                if condition == 'and':
                    matched = all(re.search(r, haystack, re.I) for r in regex)
                else:
                    matched = any(re.search(r, haystack, re.I) for r in regex)
            except re.error:
                matched = False
        elif mtype == 'binary':
            matched = False  # binary matching not implemented
        elif mtype == 'dsl':
            # F38: dsl 子集——status_code/contains()/len()/all() + and/or/not
            exprs = m.get('dsl', [])
            vals = {
                'status_code': status,
                'len': len(body),
                'true': True, 'false': False,
            }
            def _ev(expr):
                e = expr
                # contains(x, y) → x in haystack-ish(body/header)
                import re as _rr
                def _contains(mm):
                    hay_name, needle = mm.group(1), mm.group(2)
                    hay = body_str if hay_name in ('body', 'string') else header_str
                    return needle.strip('"\'') in hay
                e = _rr.sub(r"(\w+)\s*!?=~?\s*['\"]([^'\"]*)['\"]", lambda mm: repr(mm.group(2) in body_str), e)
                e = _rr.sub(r"contains\((\w+),\s*['\"]([^'\"]*)['\"]\)", lambda mm: str(mm.group(2) in (body_str if mm.group(1) not in ('header',) else header_str)), e)
                e = _rr.sub(r"len\((\w+)\)", lambda mm: str(len(body_str) if mm.group(1) not in ('header',) else len(header_str)), e)
                e = _rr.sub(r"status_code", str(status), e)
                e = _rr.sub(r"\btrue\b", 'True', e)
                e = _rr.sub(r"\bfalse\b", 'False', e)
                e = e.replace(' && ', ' and ').replace(' || ', ' or ')
                try:
                    return bool(eval(e, {'__builtins__': {}}, dict(vals)))
                except Exception:
                    return False
            results_dsl = [_ev(x) for x in exprs]
            matched = all(results_dsl) if (m.get('condition', 'or') != 'or') else any(results_dsl)

        # negative matcher
        if m.get('negative', False):
            matched = not matched

        results.append(matched)

    if not results:
        return False
    cond = (matchers[0] if not matchers[0].get('internal') else (matchers[1] if len(matchers) > 1 else {})).get('condition')
    # F38: 请求级 condition——matchers 间默认 and,nuclei 请求级 condition: or
    # 被 AND 化是 22% tech 模板漏报根因(自评);matchers 平铺无组结构,
    # 请求级 or 语义 = 任一非 internal matcher 命中即可。
    req_cond = None
    for m0 in matchers:
        if not m0.get('internal'):
            req_cond = m0.get('condition')
            break
    return any(results) if req_cond == 'or' and len(matchers) > 1 else all(results)

def apply_extractors(extractors, status, headers, body):
    """执行 extractors(提取动态值)
    F29: part 支持——header/all/response 时 regex 搜对应面(此前只搜 body,
    纯 extractor 模板永不触发)。"""
    body_str = body.decode('utf-8', errors='replace')
    header_str = '\r\n'.join(f'{k}: {v}' for k, v in headers.items())
    extracted = {}
    for ex in extractors or []:
        extype = ex.get('type', '')
        name = ex.get('name', f'ext_{len(extracted)}')
        part = (ex.get('part') or 'body').lower()
        haystack = header_str if part in ('header',) else (
            f'{status}\r\n{header_str}\r\n{body_str}' if part in ('all', 'response') else body_str)
        if extype == 'regex':
            group = ex.get('group', 1)
            for pattern in ex.get('regex', []):
                m = re.search(pattern, haystack, re.I | re.S)
                if m and len(m.groups()) >= group:
                    extracted[name] = m.group(group)
                    break
        elif extype == 'kval':
            for pair in ex.get('kval', []):
                k, _, v = pair.partition(':')
                for hk, hv in headers.items():
                    if hk.lower() == k.strip().lower():
                        extracted[name] = hv
                        break
    return extracted

# ============================================================
# DNS 请求引擎(nuclei dns 协议)
# ============================================================

def do_dns(req_spec, target_domain):
    """执行 DNS 查询"""
    import dns.resolver
    r = dns.resolver.Resolver()
    r.nameservers = ['8.8.8.8', '1.1.1.1']
    r.timeout = 5
    rec = req_spec.get('type', 'A')
    name = req_spec.get('name', target_domain)
    try:
        answers = r.resolve(name, rec)
        return [str(a) for a in answers]
    except Exception:
        return []

def run_dns_matchers(matchers, answers):
    results = []
    for m in matchers or []:
        if m.get('type') == 'word':
            words = m.get('words', [])
            matched = any(any(w.lower() in str(a).lower() for a in answers) for w in words)
            results.append(matched)
    if not results:
        return False
    cond = (matchers[0] if not matchers[0].get('internal') else (matchers[1] if len(matchers) > 1 else {})).get('condition')
    # F38: 请求级 condition——matchers 间默认 and,nuclei 请求级 condition: or
    # 被 AND 化是 22% tech 模板漏报根因(自评);matchers 平铺无组结构,
    # 请求级 or 语义 = 任一非 internal matcher 命中即可。
    req_cond = None
    for m0 in matchers:
        if not m0.get('internal'):
            req_cond = m0.get('condition')
            break
    return any(results) if req_cond == 'or' and len(matchers) > 1 else all(results)

# ============================================================
# 主执行流程
# ============================================================

def execute_template(tpl, target, timeout=15):
    """执行单个模板——返回 findings 列表"""
    findings = []
    tpl_id = tpl.get('id', 'unknown')
    info = tpl.get('info', {})

    # http 协议(社区模板顶层键是 http:;requests: 为旧式/自定义兼容)
    # F27: 此前只读 requests 导致社区 14k 模板全部 0 请求假完成。
    http_specs = tpl.get('http') or tpl.get('requests') or []
    for req_spec in http_specs:
        # interactsh(OOB)标记——跳过(无 OOB 基础设施时)
        if '{{interactsh-url}}' in json.dumps(req_spec):
            continue

        # F29: raw 原文请求块(METHOD /path HTTP/1.1 + 头 + 体)
        raw_blocks = req_spec.get('raw') or []
        if raw_blocks and ' HTTP/' in str(raw_blocks[0]).split('\n')[0]:
            rb = raw_blocks[0]
            head, _, rbody = rb.partition('\n\n')
            reqline = head.split('\n')[0].strip()
            parts = reqline.split()
            if len(parts) >= 2:
                rh = {}
                for hl in head.split('\n')[1:]:
                    if ':' in hl:
                        k, _, v = hl.partition(':')
                        rh[k.strip()] = v.strip()
                req_spec = dict(req_spec)
                req_spec['path'] = parts[1]
                req_spec['method'] = parts[0]
                req_spec['headers'] = {**rh, **(req_spec.get('headers') or {})}
                if rbody:
                    req_spec['body'] = rbody
        # 多 path 支持(nuclei 标准: path 是 list,每个都试)
        raw_paths = req_spec.get('path', '/')
        path_list = raw_paths if isinstance(raw_paths, list) else [raw_paths]
        for one_path in path_list:
            sub_spec = dict(req_spec)
            sub_spec['path'] = one_path
            status, headers, body = do_http(sub_spec, target)
            if body in (b'__OUTBOUND_BLOCKED__', b'__UNRESOLVED_VAR__'):
                continue  # F29 围栏 / F37 未解析变量——均不算命中
            matchers = req_spec.get('matchers', tpl.get('matchers', []))
            ext_q = req_spec.get('extractors', tpl.get('extractors', []))
            if not matchers and ext_q:
                # F29: 纯 extractor 模板(社区 187 个)——提取到值即命中
                ex_hit = apply_extractors(ext_q, status, headers, body)
                if ex_hit:
                    shown0 = one_path if isinstance(one_path, str) else str(one_path)
                    findings.append({
                        'template-id': tpl_id, 'name': info.get('name', tpl_id),
                        'severity': info.get('severity', 'unknown'), 'type': 'http',
                        'matched-at': shown0.replace('{{BaseURL}}', target.rstrip('/')),
                        'extracted': ex_hit,
                    })
                    break
                continue
            if apply_matchers(matchers, status, headers, body):
                extractors = req_spec.get('extractors', tpl.get('extractors', []))
                extracted = apply_extractors(extractors, status, headers, body)
                shown = one_path if isinstance(one_path, str) else str(one_path)
                findings.append({
                    'template-id': tpl_id,
                    'name': info.get('name', tpl_id),
                    'severity': info.get('severity', 'unknown'),
                    'type': 'http',
                    'matched-at': shown.replace('{{BaseURL}}', target.rstrip('/')),
                    'extracted': extracted,
                    'curl': f'curl -X {req_spec.get("method", "GET")} \'{shown.replace("{{BaseURL}}", target.rstrip("/"))}\'',
                })
                break  # 一个模板一次命中即报
        if findings:
            break

    # dns 协议
    for req_spec in tpl.get('dns', []) or []:
        try:
            import dns.resolver
        except ImportError:
            break
        answers = do_dns(req_spec, target.replace('https://', '').replace('http://', ''))
        matchers = req_spec.get('matchers', [])
        if run_dns_matchers(matchers, answers):
            findings.append({
                'template-id': tpl_id,
                'name': info.get('name', tpl_id),
                'severity': info.get('severity', 'unknown'),
                'type': 'dns',
                'matched-at': target,
                'answers': answers,
            })
            break

    return findings

def main():
    p = argparse.ArgumentParser(description='spectre-nuclei: nuclei 模板执行引擎')
    p.add_argument('mode', choices=['run', 'list'])
    p.add_argument('--target', help='目标 URL/域名')
    p.add_argument('--templates', help='模板目录')
    p.add_argument('--template', help='单个模板文件')
    p.add_argument('--search', help='list 模式搜索关键词')
    p.add_argument('--severity', help='过滤严重性: critical,high,medium,low')
    p.add_argument('--output', help='输出 JSON 文件')
    p.add_argument('--concurrent', type=int, default=10)
    args = p.parse_args()

    if args.mode == 'list':
        if not args.templates:
            print('list 需要 --templates', file=sys.stderr); sys.exit(1)
        tmpls = list_templates(args.templates, args.search)
        for t in tmpls:
            print(f"[{t['severity']:>8}] {t['id']} — {t['name']}  ({t['path'].split('/nuclei-templates/')[-1]})")
        print(f'\n{len(tmpls)} templates')
        return 0

    if not args.target:
        print('run 需要 --target', file=sys.stderr); sys.exit(1)

    # 收集模板
    templates = []
    if args.template:
        templates = [load_template(args.template)]
    elif args.templates:
        t_load0 = time.time()
        for t in list_templates(args.templates, args.search):
            templates.append(load_template(t['path']))
        t_load = time.time() - t_load0
    else:
        print('需要 --template 或 --templates', file=sys.stderr); sys.exit(1)

    # 严重性过滤
    if args.severity:
        sevs = [s.strip().lower() for s in args.severity.split(',')]
        templates = [t for t in templates if t.get('info', {}).get('severity', '').lower() in sevs]

    # 执行
    all_findings = []
    t0 = time.time()
    print(f'[*] {len(templates)} templates → {args.target}'
          + (f' (模板加载 {t_load:.1f}s)' if args.templates else ''))

    for i, tpl in enumerate(templates):
        try:
            findings = execute_template(tpl, args.target)
            for f in findings:
                sev = f.get('severity', 'unknown')
                icon = {'critical': '🔴', 'high': '🟠', 'medium': '🟡', 'low': '🔵'}.get(sev, '⚪')
                print(f'{icon} [{sev}] {f["template-id"]}: {f["name"]} @ {f.get("matched-at", "")}')
                if f.get('extracted'):
                    print(f'   extracted: {f["extracted"]}')
                all_findings.append(f)
        except KeyboardInterrupt:
            print('\n[!] interrupted'); break
        except Exception as e:
            continue

    elapsed = time.time() - t0  # F29: 执行段墙钟(加载段单列)
    print(f'\n[✓] {len(all_findings)} findings in {elapsed:.1f}s ({len(templates)} templates)')

    if args.output:
        json.dump(all_findings, open(args.output, 'w'), indent=2, ensure_ascii=False)
        print(f'  → {args.output}')

    return 0

if __name__ == '__main__':
    sys.exit(main())
