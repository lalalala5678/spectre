#!/usr/bin/env python3
"""c2-qa — 面杀 Q&A 循环治具(引擎适配+迭代+交付)。
用法:
  c2-qa.py run --payload p.java --engines clamav,yara [--max-rounds 8]
  c2-qa.py scan --payload p.java            # 单次引擎矩阵
引擎适配器:clamav(本地,clamscan)/yara(本地规则集)/threatbook(微步云,需
THREATBOOK_API_KEY)/vt(VT,需 VT_API_KEY)/private(私架端点 PRIVATE_QA_URL)。
输出:JSON 结果矩阵;run 模式联动 c2-variant 迭代(全过=交付包)。
授权门:读数据根 c2/scope.json(_data_root() 双运行位),targets 空/出窗=拒绝运行。
"""
import sys, os, json, subprocess, hashlib, time, glob

def _data_root():
    """数据根(R32D36 双运行位唯一制式): 容器内 /opt/tools 是 bind 挂载
    (bootstrap 标记识别); 宿主侧 SPECTRE_DATA_DIR。返回 tools 目录。"""
    if os.path.exists('/opt/tools/bootstrap-sandbox.sh'):
        return '/opt/tools'
    return os.path.join(os.environ.get('SPECTRE_DATA_DIR', '/var/lib/spectre'), 'tools')

SCOPE = os.path.join(_data_root(), 'c2/scope.json')
AUDIT = os.path.join(_data_root(), 'c2/audit.log')  # CS8-P1-2 统一制式

def gate(payload=''):
    if not os.path.exists(SCOPE):
        print('SCOPE-REJECT: no scope file'); sys.exit(75)
    # EDUSRC 硬隔离(工具层):旗标=1/true/yes,或工作区/载荷路径含 edusrc
    ev = os.environ.get('SPECTRE_EDUSRC', '')
    ev_hit = ev.lower() in ('1', 'true', 'yes') or ('edusrc' in ev.lower())
    for m in ((ev_hit and 'EDUSRC-FLAG') or '', os.getcwd(), payload):
        if m and 'edusrc' in str(m).lower():
            audit('EDUSRC', 'REJECT', '', 'edusrc workspace hard isolation')
            print('EDUSRC-REJECT: 教育 SRC 工作区禁用 C2 载荷能力(工具层硬隔离)')
            sys.exit(76)
    sc = json.load(open(SCOPE))
    t = time.time()
    try:
        ok = (sc.get('targets') and
              sc.get('exercise') and
              sc['window']['start'] and
              sc['window']['end'] and
              sc['window']['start'] <= time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t)) <= sc['window']['end'])
    except Exception:
        ok = False
    if not ok:
        # CS8-P2-2: exercise 与 targets/window 同为必填(cmd_scan 等
        # 无条件消费 sc['exercise'], 此前按文档造的 scope 裸 KeyError)。
        print('SCOPE-REJECT: empty targets/exercise or out of window')
        sys.exit(75)
    return sc

def audit(target, action, sha, note=''):
    os.makedirs(os.path.dirname(AUDIT), exist_ok=True)
    with open(AUDIT, 'a') as f:
        f.write(f'{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}\t{target}\t{action}\t{sha}\t{note}\n')

def sha256f(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()

def eng_clamav(p):
    # 容器重建丢包防护(2026-09-29): FileNotFoundError 此前裸栈崩溃整轮 run
    try:
        r = subprocess.run(['clamscan', '--no-summary', p], capture_output=True, text=True, timeout=120)
    except FileNotFoundError:
        return {'engine': 'clamav', 'error': 'clamscan 未安装(容器重建丢失;账本应含 apt-get install -y clamav)——显式报错不静默'}
    if r.returncode == 2: return {'engine': 'clamav', 'error': r.stderr[:120]}
    hit = 'FOUND' in r.stdout
    name = r.stdout.split('FOUND')[0].split(':')[-1].strip() if hit else ''
    return {'engine': 'clamav', 'detected': hit, 'signature': name}

def eng_yara(p):
    import glob
    rules = sorted(glob.glob(os.path.join(_data_root(), 'c2/yara-rules/*.yar'))
                 + glob.glob(os.path.join(_data_root(), 'c2/yara-rules/*.yara')))
    if not rules:
        return {'engine': 'yara', 'detected': False, 'signature': '', 'note': 'no rules configured'}
    for rf in rules:
        try:
            r = subprocess.run(['yara', rf, p], capture_output=True, text=True, timeout=60)
        except FileNotFoundError:
            return {'engine': 'yara', 'error': 'yara 未安装(容器重建丢失;账本应含 apt-get install -y yara)——显式报错不静默'}
        if r.stdout.strip():
            return {'engine': 'yara', 'detected': True, 'signature': r.stdout.split()[0]}
    return {'engine': 'yara', 'detected': False, 'signature': ''}

def _load_api_keys():
    """读设置面板写入的已验证 keys(仅验证通过的才落盘)。路径经
    _data_root() 双运行位统一(CS8-P1-2)。"""
    try:
        return json.load(open(os.path.join(_data_root(), 'c2/api-keys.json')))
    except Exception:
        return {}

def eng_threatbook(p):
    """微步云查: 文件上传接口 https://x.threatbook.com/api/v3/file/upload"""
    keys = _load_api_keys()
    tb = keys.get('threatbook') or {}
    key = tb.get('key') or os.environ.get('THREATBOOK_API_KEY', '')
    if not key:
        return {'engine': 'threatbook', 'error': '未配置微步 API key(设置面板 → C2 免杀云查)——显式报错不静默'}
    import urllib.request, uuid
    b = uuid.uuid4().hex
    sha = sha256f(p)
    with open(p, 'rb') as f:
        content = f.read()
    body = (f'--{b}\r\nContent-Disposition: form-data; name="apikey"\r\n\r\n{key}\r\n'
            f'--{b}\r\nContent-Disposition: form-data; name="sandbox"\r\n\r\n0\r\n'
            f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{os.path.basename(p)}"\r\n'
            f'Content-Type: application/octet-stream\r\n\r\n').encode() + content + f'\r\n--{b}--\r\n'.encode()
    req = urllib.request.Request('https://x.threatbook.com/api/v3/file/upload', data=body, headers={
        'Content-Type': f'multipart/form-data; boundary={b}'})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            j = json.loads(r.read().decode())
    except Exception as e:
        return {'engine': 'threatbook', 'error': str(e)[:100]}
    if j.get('response_code') != 0:
        return {'engine': 'threatbook', 'error': f"微步: {j.get('verbose_msg', 'API 错误')}"}
    return {'engine': 'threatbook', 'detected': False, 'note': '已提交沙箱分析(异步,用 sha256 轮询报告)', 'sha256': sha}

def eng_vt(p):
    """VirusTotal v3: sha256 查询(不重新上传——避免样本扩散)"""
    keys = _load_api_keys()
    vt = keys.get('virustotal') or {}
    key = vt.get('key') or os.environ.get('VT_API_KEY', '')
    if not key:
        return {'engine': 'vt', 'error': '未配置 VT API key(设置面板 → C2 免杀云查)——显式报错不静默'}
    import urllib.request
    sha = sha256f(p)
    req = urllib.request.Request(f'https://www.virustotal.com/api/v3/files/{sha}',
                                 headers={'x-apikey': key})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            j = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {'engine': 'vt', 'detected': False, 'note': 'VT 无此样本(新文件,未扩散=好事)', 'sha256': sha}
        return {'engine': 'vt', 'error': f'VT HTTP {e.code}'}
    except Exception as e:
        return {'engine': 'vt', 'error': str(e)[:100]}
    stats = ((j.get('data') or {}).get('attributes') or {}).get('last_analysis_stats') or {}
    malicious = stats.get('malicious', 0) + stats.get('suspicious', 0)
    return {'engine': 'vt', 'detected': malicious > 0,
            'detail': f'{malicious}/{sum(stats.values())} 引擎报毒', 'sha256': sha}

CLOUD_ENGINES = ('threatbook', 'vt', 'metadefender', 'hybridanalysis')

def configured_cloud_engines():
    """已配置 key 的云引擎清单(api-keys.json 只含验证通过的)"""
    keys = _load_api_keys()
    return [e for e in CLOUD_ENGINES if (keys.get(e) or {}).get('key')]

def eng_metadefender(p):
    """MetaDefender Cloud v4: sha256 查已有报告;未知样本上传(异步 note)"""
    keys = _load_api_keys()
    md = keys.get('metadefender') or {}
    key = md.get('key') or os.environ.get('METADEFENDER_API_KEY', '')
    if not key:
        return {'engine': 'metadefender', 'error': '未配置 MetaDefender key(设置面板 → C2 免杀云查)——显式报错不静默'}
    import urllib.request
    sha = sha256f(p)
    req = urllib.request.Request(f'https://cloud.metadefender.com/api/v4/hash/{sha}',
                                 headers={'apikey': key})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            j = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {'engine': 'metadefender', 'detected': False,
                    'note': 'MD 云无此样本(新文件);上传属异步扫描,建议人工核验', 'sha256': sha}
        return {'engine': 'metadefender', 'error': f'MD HTTP {e.code}'}
    except Exception as e:
        return {'engine': 'metadefender', 'error': str(e)[:100]}
    res = j.get('scan_results') or {}
    det = res.get('total_detected_avs') or 0
    return {'engine': 'metadefender', 'detected': det > 0,
            'detail': f'{det}/{res.get("total_avs", "?")} 引擎报毒', 'sha256': sha}

def eng_hybridanalysis(p):
    """Hybrid Analysis v2: sha256 搜索已有沙箱报告"""
    keys = _load_api_keys()
    ha = keys.get('hybridanalysis') or {}
    key = ha.get('key') or os.environ.get('HYBRIDANALYSIS_API_KEY', '')
    if not key:
        return {'engine': 'hybridanalysis', 'error': '未配置 Hybrid Analysis key(设置面板 → C2 免杀云查)——显式报错不静默'}
    import urllib.request
    sha = sha256f(p)
    req = urllib.request.Request(
        f'https://www.hybrid-analysis.com/api/v2/search/hash?hash={sha}',
        headers={'api-key': key, 'user-agent': 'spectre', 'accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            j = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        # 404=hash 未收录(新文件未扩散, 与 VT 的 404 语义一致)=clean 而非错误
        if e.code == 404:
            return {'engine': 'hybridanalysis', 'detected': False,
                    'note': 'HA 无此样本(新文件,未扩散=好事)', 'sha256': sha}
        body = e.read().decode()[:120] if e.fp else ''
        return {'engine': 'hybridanalysis', 'error': f'HA HTTP {e.code}: {body}'}
    except Exception as e:
        return {'engine': 'hybridanalysis', 'error': str(e)[:100]}
    if not j:
        return {'engine': 'hybridanalysis', 'detected': False, 'note': 'HA 无此样本记录', 'sha256': sha}
    # verdict: 'malicious'/'suspicious' = detected
    worst = j[0].get('verdict', 'unknown')
    thr = j[0].get('threat_score', 0)
    return {'engine': 'hybridanalysis', 'detected': worst in ('malicious', 'suspicious'),
            'detail': f'verdict={worst} score={thr}', 'sha256': sha}

def eng_private(p):
    """私架沙箱适配器:POST {PRIVATE_QA_URL} multipart 字段 sample,
    鉴权头 X-SPECTRE-Token: $PRIVATE_QA_TOKEN;JSON 响应 {detected, signature, engine}。
    样本不外流(私架),接入前先问能否等效,公网引擎最小化。"""
    # 部署级私架: 文件优先(持久挂载, 重建不丢), env 兜底(裸机)
    pq = {}
    try:
        pq = json.load(open(os.path.join(_data_root(), 'c2/private-qa.json')))
    except Exception:
        pass
    url = os.environ.get('PRIVATE_QA_URL') or pq.get('url')
    if not url:
        return {'engine': 'private', 'error': 'PRIVATE_QA_URL not set(私架未部署;文件 /opt/tools/c2/private-qa.json 或环境变量)'}
    import urllib.request, uuid
    b = '----spectre' + uuid.uuid4().hex
    body = ((f'--{b}\r\nContent-Disposition: form-data; name="sample"; '
             f'filename="{os.path.basename(p)}"\r\nContent-Type: application/octet-stream\r\n\r\n'
            ).encode() + open(p, 'rb').read() + f'\r\n--{b}--\r\n'.encode())
    req = urllib.request.Request(url, data=body, headers={
        'Content-Type': f'multipart/form-data; boundary={b}',
        'X-SPECTRE-Token': os.environ.get('PRIVATE_QA_TOKEN', '') or pq.get('token', '')})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            j = json.loads(r.read().decode())
    except Exception as e:
        return {'engine': 'private', 'error': str(e)[:100]}
    return {'engine': 'private', 'detected': bool(j.get('detected')),
            'signature': j.get('signature', ''), 'sandbox': j.get('engine', '')}

def scan_all(p, engines):
    fns = {'clamav': eng_clamav, 'yara': eng_yara, 'private': eng_private,
           'threatbook': eng_threatbook, 'vt': eng_vt,
           'metadefender': eng_metadefender, 'hybridanalysis': eng_hybridanalysis}
    if 'auto' in engines:
        # 设计语义: 用户配了几家云厂商,就必须全过那几家 + 本地引擎。
        # 噪声治理: private 未配 PRIVATE_QA_URL 时 auto 不带它
        # (此前恒打一行 error,自评点名)。
        _base = ['clamav', 'yara']
        if os.environ.get('PRIVATE_QA_URL') or os.path.exists(os.path.join(_data_root(), 'c2/private-qa.json')):
            _base.append('private')
        engines = _base + configured_cloud_engines()
    out = []
    for e in engines:
        if e in fns:
            out.append(fns[e](p))
        else:
            out.append({'engine': e, 'error': 'adapter not implemented (threatbook/vt 需 API key,见 qa-loop SKILL)——显式报错不静默'})
    return out

def cmd_scan(args):
    a0 = dict(zip(args[::2], args[1::2]))
    sc = gate(a0.get('--payload', ''))
    if '--payload' not in a0:
        print('用法: c2-qa.py scan --payload <文件> [--engines clamav,yara,...]')
        return 2
    a = a0
    p = a['--payload']
    engines = a.get('--engines', 'auto').split(',')
    res = scan_all(p, engines)
    sha = sha256f(p)
    audit(sc['exercise'], 'scan', sha, json.dumps(res, ensure_ascii=False)[:200])
    print(json.dumps(res, indent=1))
    return 0

def functest(p, orig=None):
    """v2.1 功能门:文本载荷走 c2-functest;.class 走 c2-bytecode 等价守恒(签名集+加载行为)。"""
    if p.endswith('.class'):
        r = subprocess.run(['python3', '/opt/tools/bin/c2-bytecode.py', 'verify',
                            '--orig', orig or p, '--mod', p],
                           capture_output=True, text=True, timeout=180)
        line = (r.stdout.strip().splitlines() or [''])[0]
        return r.returncode == 0, line[:110]
    r = subprocess.run(['python3', '/opt/tools/bin/c2-functest.py', p],
                       capture_output=True, text=True, timeout=300)
    return r.returncode == 0, (r.stdout.strip().splitlines() or [''])[0]

def cmd_run(args):
    a0 = dict(zip(args[::2], args[1::2]))
    sc = gate(a0.get('--payload', ''))
    a = a0
    p = a['--payload']
    engines = a.get('--engines', 'auto').split(',')
    maxr = int(a.get('--max-rounds', '8'))
    fams = a.get('--families', 'mask,decomp,id,struct')  # v3:伪装令 mask 先行+签名驱动,弃 enc/code 演示桩
    base = os.path.splitext(os.path.basename(p))[0]
    work = f'/tmp/c2-qa-{base}-{int(time.time())}'
    os.makedirs(work, exist_ok=True)
    cur = p
    for r in range(1, maxr + 1):
        sha = sha256f(cur)
        res = scan_all(cur, engines)
        audit(sc['exercise'], f'round{r}', sha, json.dumps(res, ensure_ascii=False)[:200])
        print(f'-- round {r}: {json.dumps(res)}')
        if not any(x.get('detected') for x in res):
            f_ok, f_note = functest(cur)              # 交付终验:功能门
            pkg = os.path.join(work, 'DELIVERY')
            os.makedirs(pkg, exist_ok=True)
            import shutil; shutil.copy(cur, pkg)
            if not f_ok:
                json.dump({'rounds': r, 'results': res, 'sha256': sha,
                           'functest_pass': False, 'functest_note': f_note,
                           'target_exercise': sc['exercise'], 'verdict': 'AV-CLEAN-FUNCTEST-FAIL'},
                          open(os.path.join(pkg, 'report.json'), 'w'), indent=1)
                print(f'AV-CLEAN but FUNCTEST FAIL ({f_note}) — 不算通过,如实交付残骸')
                return 1
            # 伪装令交付门禁(2026-09 用户令):任一裸奔面=REJECT,不交付
            dg = subprocess.run(['python3', '/opt/tools/bin/c2-disguise.py', 'check', '--payload', cur],
                                capture_output=True, text=True)
            dgres = json.loads(dg.stdout) if dg.stdout.strip().startswith('{') else {'verdict': 'ERROR', 'bare_surfaces': ['checker-error']}
            if dgres.get('verdict') == 'REJECT':
                print(f'DISGUISE-REJECT: 裸奔面={dgres.get("bare_surfaces")} — 该候选不交付,继续迭代')
                json.dump(dgres, open(os.path.join(work, 'disguise-reject.json'), 'w'), ensure_ascii=False, indent=1)
                vo2 = os.path.join(work, f'v{r}')
                if os.path.isdir(vo2):
                    cands2 = sorted(f for f in os.listdir(vo2) if f.startswith('variant_'))
                    for c in cands2:
                        cp2 = os.path.join(vo2, c)
                        g2 = subprocess.run(['/opt/tools/bin/c2-variant.py', 'gen', '--src', cp2, '--out', vo2 + '-m', '--rounds', '2', '--families', 'mask,decomp'],
                                            capture_output=True, text=True)
                        for c2 in [x for x in os.listdir(vo2 + '-m') if x.startswith('variant_')] if os.path.isdir(vo2 + '-m') else []:
                            cp3 = os.path.join(vo2 + '-m', c2)
                            r3 = scan_all(cp3, engines)
                            if not any(x.get('detected') for x in r3):
                                cur = cp3
                                print(f'   mask 重生成 {c2}: engine-clean → 采用(下轮交付)')
                                break
                        break
                continue
            # 伪装令②交付文件名语义中性伪装
            import re as _re
            ext_ = os.path.splitext(cur)[1]
            if ext_ == '.java':
                srcb = open(cur, errors='replace').read()
                mcl = _re.search(r'public\s+class\s+((?:\\u[0-9a-fA-F]{4}|[A-Za-z0-9_$])+)', srcb) or _re.search(r'class\s+([A-Za-z0-9_$]+)', srcb)
                sem_name = (mcl.group(1) if mcl else 'CommonReportHandler') + '.java'
            elif ext_ == '.class':
                sem_name = os.path.basename(cur)     # real-lane:包路径类名本即业务化伪装
            else:
                pool = {'.php': ['session-helper.php', 'log-report.php', 'trace-config.php'],
                        '.js': ['trace-updater.js', 'polyfill-helper.js'],
                        '.ps1': ['cleanup-task.ps1', 'session-refresh.ps1']}.get(ext_, [os.path.basename(cur)])
                sem_name = pool[int(time.time()) % len(pool)]
            dstf = os.path.join(pkg, sem_name)
            os.rename(os.path.join(pkg, os.path.basename(cur)), dstf)
            # 伪装令①密钥材料随交付(connect-info.json:轮换记录=操作员连接凭据)
            mk = {}
            for vd in sorted(glob.glob(os.path.join(work, 'v*')), reverse=True):
                mfp2 = os.path.join(vd, 'manifest.json')
                if os.path.exists(mfp2):
                    for e in json.load(open(mfp2)):
                        if e.get('file') == cur and e.get('mask_keys'):
                            mk = e['mask_keys']; break
                    if mk: break
            json.dump({'exercise': sc['exercise'], 'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                       'key_rotations': mk, 'protocol_note': '密钥为本次交付随机轮换值;通信全程加密;字段/路径见 rotations'},
                      open(os.path.join(pkg, 'connect-info.json'), 'w'), ensure_ascii=False, indent=1)
            cur = dstf
            # 一次性绑定:目标×窗口×指纹,交付前 verify(过期/越界=拒)
            b = subprocess.run(['python3', '/opt/tools/bin/c2-bind.py', 'bind', '--payload', cur],
                               capture_output=True, text=True)
            v = subprocess.run(['python3', '/opt/tools/bin/c2-bind.py', 'verify', '--payload', cur],
                               capture_output=True, text=True)
            brec = {}
            sb = os.path.join(pkg, os.path.basename(cur) + '.bind.json')
            side = cur + '.bind.json'
            if os.path.abspath(side) != os.path.abspath(sb):
                if os.path.exists(side):
                    import shutil as _s; _s.copy(side, sb)
            if os.path.exists(sb):
                brec = json.load(open(sb))
            if v.returncode != 0:
                print(f'BIND-VERIFY FAIL rc={v.returncode}: {v.stdout.strip()} — 拒绝交付')
                return 1
            json.dump({'rounds': r, 'results': res, 'sha256': sha,
                       'functest_pass': f_ok, 'functest_note': f_note,
                       'binding': brec, 'target_exercise': sc['exercise']},
                      open(os.path.join(pkg, 'report.json'), 'w'), indent=1)
            print(f'PASS after {r} rounds (functest OK, bind {brec.get("target","?")}) → {pkg}')
            return 0
        # 迭代:调变体引擎(签名驱动族+多候选,功能门过滤)
        vo = os.path.join(work, f'v{r}')
        if cur.endswith('.class'):
            # real-lane:字节码变换族(cp-ldc-split)
            g = subprocess.run(['python3', '/opt/tools/bin/c2-bytecode.py', 'split',
                                '--class', cur, '--out', vo], capture_output=True, text=True)
            cands = []
            mfp = os.path.join(vo, 'manifest.json')
            if os.path.exists(mfp):
                cands = [e['file'] for e in json.load(open(mfp))]  # 绝对路径直用
        else:
            g = subprocess.run(['/opt/tools/bin/c2-variant.py', 'gen', '--src', cur, '--out', vo,
                                '--rounds', '4', '--families', fams],
                               capture_output=True, text=True)
            cands = sorted(f for f in os.listdir(vo) if f.startswith('variant_')) if os.path.isdir(vo) else []
        nxt, best, best_res = None, None, None
        for c in cands:
            cp = os.path.join(vo, c) if not c.startswith('/') else c
            fok, fnote = functest(cp, orig=p)
            if not fok:
                print(f'   cand {c}: functest FAIL ({fnote}) — 弃')
                continue
            cres = scan_all(cp, engines)
            if not any(x.get('detected') for x in cres):
                nxt = cp
                print(f'   cand {c}: functest OK + engine-clean → 采用')
                break
            if best is None:
                best, best_res = cp, cres
        if nxt is None and best is not None:
            nxt = best
            print(f'   cand {os.path.basename(best)}: functest OK,残留 {[x["signature"] for x in best_res if x.get("detected")]} → 下轮继续')
        if nxt is None:
            print('no functional candidate this round (see manifest); continue')
            continue
        cur = nxt
    print('MAX ROUNDS reached; best effort above — 残留明细如实交付')
    return 1

def main():
    if len(sys.argv) < 2:
        print(__doc__); return 2
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == 'scan': return cmd_scan(args)
    if cmd == 'run': return cmd_run(args)
    print(__doc__); return 2

if __name__ == '__main__':
    sys.exit(main() or 0)
