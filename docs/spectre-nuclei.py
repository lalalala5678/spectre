#!/usr/bin/env python3
"""spectre-nuclei — nuclei YAML 模板执行引擎(P0 借鉴)
兼容 nuclei 模板子集: id/info/matcher/extractor/requests[dns,http]/raw
直接执行社区 8000+ 模板,无需 Go 二进制。
用法:
  spectre-nuclei run --target http://x.com --templates /path/to/nuclei-templates/
  spectre-nuclei run --target http://x.com --template /path/to/cve.yaml
  spectre-nuclei list --templates /path/to/nuclei-templates/ --search weblogic
"""
import sys, os, json, re, argparse, time
import yaml
import urllib.request, urllib.error
import ssl

for _p in ('/opt/tools/py', '/opt/tools/py/dkim', '/opt/tools/py/semgrep', '/opt/tools/py/dirsearch'):
    if _p not in sys.path:
        sys.path.insert(0, _p)

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

def do_http(req_spec, target, timeout=10):
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
    _pl = {**(req_spec.get('variables') or {}), **(req_spec.get('payloads') or {})}
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
        resp = opener.open(req, timeout=timeout)
        return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()
    except Exception as e:
        return 0, {}, str(e).encode()

# ============================================================
# 匹配器(nuclei matchers 子集)
# ============================================================

def _capture_internal_words(matchers, results, hay):
    """F39: internal matcher 命中值→变量(多请求传递: nuclei 语义
    internal word 命中的具体词可在后续请求 {{name}} 引用)。
    只捕 internal:true 且命中且带 name 的 matcher, 累积到同一 dict
    (CS14-2/3: 恢复 internal-only 过滤与累积语义——去重时曾丢失)。
    hay 为待搜文本(HTTP 版=part 对应的 header/body 串, 由调用侧
    路由; DNS 版=answers 全文本)。返回捕获 dict 或 None。
    CS13-6: 此前 HTTP/DNS 两份逐行重复(复制改名事故的温床)。"""
    captured = {}
    for m, hit in zip(matchers, results):
        if m.get('internal') and hit and m.get('name'):
            for w in (m.get('words') or []):
                if w.lower() in hay.lower():
                    captured[m['name']] = w
                    break
    return captured or None

def apply_matchers(matchers, status, headers, body, req_condition=None):
    """执行 matchers——组合语义由请求级 matchers-condition 决定
    (nuclei 默认 and; or 时任一非 internal 命中即中, 见 F38 块;
    internal 占位不参与组合——F5/CS15-5)。纯 internal 模板的变量
    捕获返回 dict: 纯 internal 组不带 __hit__(调用方 continue 走链),
    真命中+同请求捕获带 __hit__: True(落 finding)(F29/F6)。"""
    req_cond = req_condition or 'and'
    # F29: internal:true 是条件匹配器,不构成最终命中——纯 internal 模板
    # 一律不判中(防"任何 200 服务器被报 critical RCE")。
    matchers = matchers or []
    body_str = body.decode('utf-8', errors='replace')
    header_str = '\n'.join(f'{k}: {v}' for k, v in headers.items())
    if matchers and all(m.get("internal") for m in matchers):
        # F39: 纯 internal 请求=变量捕获步骤(多请求链第一跳),
        # 捕获命中词返回 dict;非最终命中(F29 反假阳性语义保持)。
        captured = {}
        for m in matchers:
            if not m.get('name'):
                continue
            hay = header_str if m.get('part') == 'header' else body_str
            for w in (m.get('words') or []):
                if w.lower() in hay.lower():
                    captured[m['name']] = w
                    break
        return {'__vars__': captured} if captured else False
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
            # F40: nuclei word 默认大小写敏感;case-insensitive: true 才不敏感
            # (恒不敏感曾放大 FP 面)
            ci = bool(m.get('case-insensitive'))
            def _has(w, h):
                return (w.lower() in h.lower()) if ci else (w in h)
            if condition == 'and':
                matched = all(_has(w, haystack) for w in words)
            else:
                matched = any(_has(w, haystack) for w in words)
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
                # F41: 只替换独立 status_code——re.sub 无界会吞
                # status_code_2 → '200_2' 数字字面量恒真(CVE-2021-45968
                # FP 实锤);带 _N 后缀的多请求变量保持字面量→eval False
                e = _rr.sub(r"(?<![\w])status_code(?![\w])", str(status), e)
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
    # F38: 请求级 condition——matchers 间默认 and,nuclei 请求级 condition: or
    # 被 AND 化是 22% tech 模板漏报根因(自评);matchers 平铺无组结构,
    # 请求级 or 语义 = 任一非 internal matcher 命中即可。
    # F38-修: 请求级组合读 nuclei 真实键 matchers-condition(默认 and);
    # 此前把 matcher 内 condition(其 words 的 or)误当请求级 →
    # status 单独命中即 FP(exposures 复扫 azure 类实锤)。
    # F5/CS15-5: internal 占位(results 里恒 True)不参与 or 组合——
    # 此前 any(results) 被占位撑成恒 True, 全部真实 matcher 未命中
    # 也判中(FP 方向, 与 :198 行内注释/docstring/F38 三处自述矛盾)。
    real = [r for r, m in zip(results, matchers) if not m.get('internal')]
    final = any(real) if req_cond == 'or' and len(matchers) > 1 else all(results)
    if final:
        captured = {}
        for m, hit in zip(matchers, results):
            if not (m.get('internal') and hit and m.get('name')):
                continue
            hay = header_str if m.get('part') == 'header' else body_str
            captured.update(_capture_internal_words([m], [hit], hay) or {})
        if captured:
            # CS15-F6 修: 真命中(非纯 internal 组合)带 __hit__ 旗标——
            # 捕获与命中可同请求并存; 纯 internal 捕获跳(早分支/全部
            # internal)不带, 调用方 continue 走链。
            return {'__vars__': captured, '__hit__': not all(
                m.get('internal') for m in matchers)}
    return final

def apply_extractors(extractors, status, headers, body):
    """执行 extractors(提取动态值)
    F29: part 支持——header/all/response 时 regex 搜对应面(此前只搜 body,
    纯 extractor 模板永不触发)。
    F42: internal: true extractor 命中值进 __vars__(与 internal matcher
    捕获合流,多请求 {{name}} 引用——nuclei extract-to 同语义)。"""
    body_str = body.decode('utf-8', errors='replace')
    header_str = '\r\n'.join(f'{k}: {v}' for k, v in headers.items())
    extracted = {}
    _vars_out = {}
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
        if ex.get('internal') and name in extracted:
            _vars_out[name] = extracted[name]
    if _vars_out:
        extracted['__vars__'] = _vars_out
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

def run_dns_matchers(matchers, answers, req_condition=None):
    """执行 DNS matchers。组合语义: 请求级 matchers-condition(默认 and)。
    CS14-6: 显式传参——此前经 apply_matchers._req_condition 函数属性
    通道隐式继承同模板 HTTP 段的条件。CS14-7: results 按索引对齐
    matchers(非 word 型记 None 不参与组合, 修复 zip 配对错位)。"""
    results = []
    for m in matchers or []:
        if m.get('type') == 'word':
            words = m.get('words', [])
            matched = any(any(w.lower() in str(a).lower() for a in answers) for w in words)
            results.append(matched)
        else:
            results.append(None)
    # F38: 请求级组合读模板自身 matchers-condition(默认 and);
    # CS15-4: 旧 `if not results` 守卫被 eff 滤除完全吸收, 已删。
    # CS14-7: results 按索引对齐 matchers——非 word 型记 None 不参与。
    eff = [r for r in results if r is not None]
    if not eff:
        return False
    req_cond = req_condition or 'and'
    final = any(eff) if req_cond == 'or' and len(matchers) > 1 else all(eff)
    # F39: internal matcher 命中值→变量(多请求传递:nuclei 语义
    # internal word 命中的具体词可在后续请求 {{name}} 引用)
    if final:
        # CS12-N2: DNS 情况下无 header/body——hay 取 answers 全文本
        # (此前从 HTTP 版复制未改名, header_str/body_str 未定义→
        # NameError 被 main 的 except 静默吞掉, 模板被跳过)。
        hay = ' '.join(str(a) for a in answers)
        captured = _capture_internal_words(matchers, results, hay)
        if captured:
            return {'__vars__': captured}
    return final

# ============================================================
# 主执行流程
# ============================================================

def execute_template(tpl, target, timeout=15):
    """执行单个模板——返回 findings 列表(超时经 do_http 透传)"""
    findings = []
    tpl_id = tpl.get('id', 'unknown')
    info = tpl.get('info', {})

    # http 协议(社区模板顶层键是 http:;requests: 为旧式/自定义兼容)
    # F27: 此前只读 requests 导致社区 14k 模板全部 0 请求假完成。
    http_specs = tpl.get('http') or tpl.get('requests') or []
    captured_vars = {}  # F39: 跨请求变量(internal matcher 捕获)
    for req_spec in http_specs:
        # interactsh(OOB)标记——跳过(无 OOB 基础设施时)
        if '{{interactsh-url}}' in json.dumps(req_spec):
            continue
        # F41: flow: 条件编排未支持(979 模板 15.8%)——执行会
        # 误判(3/4 剩余 FP 根因),整体跳过=诚实 FN 边界
        if req_spec.get('flow') or tpl.get('flow'):
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
        # F39: 前序请求捕获变量注入本请求(path/body 的 {{name}})
        if captured_vars:
            import json as _json_dumps
            spec_str = _json_dumps.dumps(req_spec)
            for k, v in captured_vars.items():
                spec_str = spec_str.replace('{{' + k + '}}', v)
            req_spec = _json_dumps.loads(spec_str)
        # 多 path 支持(nuclei 标准: path 是 list,每个都试)
        raw_paths = req_spec.get('path', '/')
        path_list = raw_paths if isinstance(raw_paths, list) else [raw_paths]
        for one_path in path_list:
            sub_spec = dict(req_spec)
            sub_spec['path'] = one_path
            status, headers, body = do_http(sub_spec, target, timeout=timeout)
            if body in (b'__OUTBOUND_BLOCKED__', b'__UNRESOLVED_VAR__'):
                continue  # F29 围栏 / F37 未解析变量——均不算命中
            matchers = req_spec.get('matchers', tpl.get('matchers', []))
            ext_q = req_spec.get('extractors', tpl.get('extractors', []))
            if not matchers and ext_q:
                # F29: 纯 extractor 模板(社区 187 个)——提取到值即命中
                ex_hit = apply_extractors(ext_q, status, headers, body)
                if isinstance(ex_hit, dict):
                    captured_vars.update(ex_hit.pop('__vars__', {}))
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
            # F40-修: matched-at 用解析后的路径——do_http 内部替换不发回,
            # shown 仍是原始 {{var}};先在此做同款替换(BaseURL/payloads/
            # variables/randstr),兜底判定才不误杀合法命中
            _vars_pl = {**(req_spec.get('variables') or {}),
                        **(req_spec.get('payloads') or {})}
            def _resolve_disp(p_str):
                out = str(p_str).replace('{{BaseURL}}', target.rstrip('/'))
                import random as _r2, string as _s2, re as _re4
                def _rr(mm):
                    n2 = mm.group(1)
                    ln = int(n2) if n2 and n2.isdigit() else 8
                    return ''.join(_r2.choices(_s2.ascii_lowercase, k=ln))
                out = _re4.sub(r'\{\{randstr[_ ]?(\d+)?\}\}', _rr, out)
                for kk, vv in _vars_pl.items():
                    if isinstance(vv, list):
                        vv = vv[0] if vv else ''
                    out = out.replace('{{' + kk + '}}', str(vv))
                return out
            # F42: internal extractor 的捕获变量(extract-to 语义)
            _pre_ext = req_spec.get('extractors', tpl.get('extractors', []))
            _pre_hits = apply_extractors(_pre_ext or [], status, headers, body)
            if isinstance(_pre_hits, dict):
                captured_vars.update(_pre_hits.pop('__vars__', {}))
            _mres = apply_matchers(matchers, status, headers, body,
                                   (req_spec.get('matchers-condition') or 'and'))
            if isinstance(_mres, dict):
                captured_vars.update(_mres.get('__vars__', {}))
                if not _mres.get('__hit__'):
                    # R32D42-P1: 纯 internal 捕获跳是链的中间步骤——
                    # 变量入池后 continue 到下一请求, 不是最终命中
                    # (此前当命中→链首跳即断+末跳必败也报 FP+归因错)。
                    continue
                # 混合型: 真命中+同请求捕获——落 finding(走下方公共
                # 命中路径; CS15-F6: 批次 X 曾把这类也 continue 丢报)。
            if _mres:
                extractors = req_spec.get('extractors', tpl.get('extractors', []))
                extracted = apply_extractors(extractors, status, headers, body)
                shown = one_path if isinstance(one_path, str) else str(one_path)
                _ma = _resolve_disp(shown)
                if '{{' in _ma:
                    break  # F40: 变量未解析的命中=字面量 FP,丢弃
                findings.append({
                    'template-id': tpl_id,
                    'name': info.get('name', tpl_id),
                    'severity': info.get('severity', 'unknown'),
                    'type': 'http',
                    'matched-at': _ma,
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
        dns_cond = req_spec.get('matchers-condition')
        if run_dns_matchers(matchers, answers, req_condition=dns_cond):
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
