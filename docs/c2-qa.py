#!/usr/bin/env python3
"""c2-qa — 面杀 Q&A 循环治具(引擎适配+迭代+交付)。
用法:
  c2-qa.py run --payload p.java --engines clamav,yara [--max-rounds 8]
  c2-qa.py scan --payload p.java            # 单次引擎矩阵
引擎适配器:clamav(本地,clamscan)/yara(本地规则集)/threatbook(微步云,需
THREATBOOK_API_KEY)/vt(VT,需 VT_API_KEY)/metadefender(需 METADEFENDER_API_KEY)/
hybridanalysis(需 HYBRIDANALYSIS_API_KEY)/private(私架端点 PRIVATE_QA_URL)。
输出:JSON 结果矩阵;run 模式联动 c2-variant 迭代(全过=交付包)。
授权门:$SPECTRE_DATA_DIR/tools/c2/scope.json(容器位 /opt/tools/c2/, 宿主位数据根 tools/c2/),targets/exercise/窗口三必填。
"""
import sys, os, json, subprocess, time, glob
from _common import scope_gate_full, audit_log, _edusrc_hit, _data_root, sha256f, FAMILIES  # CS69-2/CS70-3: 归顶+裸名(c2-variant 先例)


AUDIT = os.path.join(_data_root(), 'c2/audit.log')  # CS36-Z4: 五列制式单源(_common.audit_log)

def gate():
    # CS44-F3: 收敛 _common 单源门(basetype/bytecode 同款 wrapper——此前
    # ~29 行本地孤本+死参 payload)。qa 独有差异仅 EDUSRC 拒绝落审计行。
    # 门序族统一=edusrc 先; scope 三必填/缺/坏 JSON 全在单源门。
    if _edusrc_hit():
        audit('EDUSRC', 'REJECT', '', 'edusrc workspace hard isolation')
        print('EDUSRC-REJECT: 教育 SRC 工作区禁用 C2 载荷能力(工具层硬隔离)', file=sys.stderr)
        sys.exit(76)
    return scope_gate_full()

def audit(target, action, sha, note=''):
    audit_log(AUDIT, target, action, sha, note)  # CS36-Z4: 单源写者


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
        # R32D38-NEW-5: 无规则=引擎未运行(detected:False 会污染
        # AV-clean 判定)——归 error 面, run 侧 usable 过滤接管。
        return {'engine': 'yara', 'error': 'yara 无规则集(数据根 c2/yara-rules/ 空)'}
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
        return {'engine': 'private', 'error': f"PRIVATE_QA_URL not set(私架未部署;文件 {os.path.join(_data_root(), 'c2/private-qa.json')} 或环境变量)"}
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
    sc = gate()
    if '--payload' not in a0:
        print('用法: c2-qa.py scan --payload <文件> [--engines clamav,yara,...]')
        return 2
    a = a0
    p = a['--payload']
    # R32D72-N1/CS52-F7: 文件缺/非常规干净 rc=2(族模板文案)。
    if not os.path.isfile(p):
        print(f'用法错误: --payload 文件不存在或不是常规文件: {p}', file=sys.stderr); return 2
    engines = a.get('--engines', 'auto').split(',')
    res = scan_all(p, engines)
    sha = sha256f(p)
    audit(sc['exercise'], 'scan', sha, json.dumps(res, ensure_ascii=False)[:200])
    # R32D68-OBS2: 全引擎缺席时 stderr 人类可读一行(stdout JSON 保持
    # 机器可消费/rc 不变——智能体按 error 字段判)。
    # R32D69-F1: scan_all 返回 list(此前 .values() 作用在 list 上必崩)。
    if res and all(isinstance(r, dict) and r.get('error') for r in res):
        print('注: 本机零引擎可用——全部引擎结果均为错误(未安装/超时/崩溃), 修复指引见各引擎 error 字段', file=sys.stderr)
    print(json.dumps(res, indent=1))
    return 0

def functest(p, orig=None):
    """v2.1 功能门:文本载荷走 c2-functest;.class 走 c2-bytecode 等价守恒(签名集+加载行为)。"""
    if p.endswith('.class'):
        r = subprocess.run(['python3', os.path.join(_data_root(), 'bin/c2-bytecode.py'), 'verify',
                            '--orig', orig or p, '--mod', p],
                           capture_output=True, text=True, timeout=180)
        line = (r.stdout.strip().splitlines() or [''])[0]
        return r.returncode == 0, line[:110]
    r = subprocess.run(['python3', os.path.join(_data_root(), 'bin/c2-functest.py'), p],
                       capture_output=True, text=True, timeout=300)
    return r.returncode == 0, (r.stdout.strip().splitlines() or [''])[0]

def cmd_run(args):
    a0 = dict(zip(args[::2], args[1::2]))
    sc = gate()
    if '--payload' not in a0:  # R32D38-NEW-4: 与 scan 同款用法行
        print('用法: c2-qa.py run --payload <文件> [--engines ...] '
              '[--max-rounds N] [--families mask,decomp,id,struct]')
        return 2
    a = a0
    p = a['--payload']
    # CS52-F1: run 子命令同守卫(N1 只修了 scan——缺文件裸栈)。
    if not os.path.isfile(p):
        print(f'用法错误: --payload 文件不存在或不是常规文件: {p}', file=sys.stderr); return 2
    engines = a.get('--engines', 'auto').split(',')
    maxr = int(a.get('--max-rounds', '8'))
    fams = a.get('--families', 'mask,decomp,id,struct')  # v3:伪装令 mask 先行+签名驱动,弃 enc/code 演示桩
    # CS53-NEW-B: 转发面前置校验(此前拼写错在子进程 rc=2 被吞, 8 轮
    # 空转+假 manifest 指针)。
    _toks = fams.split(',')
    _bad = [x for x in _toks if x and x not in FAMILIES]
    if _bad or not any(_toks):
        print(f"用法错误: --families 未知/空族名: {fams}(合法: {','.join(FAMILIES)})", file=sys.stderr)
        return 2
    base = os.path.splitext(os.path.basename(p))[0]
    work = f'/tmp/c2-qa-{base}-{int(time.time())}'
    os.makedirs(work, exist_ok=True)
    cur = p
    for r in range(1, maxr + 1):
        sha = sha256f(cur)
        res = scan_all(cur, engines)
        audit(sc['exercise'], f'round{r}', sha, json.dumps(res, ensure_ascii=False)[:200])
        print(f'-- round {r}: {json.dumps(res)}')
        # R32D38-NEW-5: 引擎全 error ≠ AV-clean——error 条目无 detected
        # 键, 此前 not any(detected) 成立即进交付流(全新部署未装重型
        # 引擎时空转全绿)。可用引擎=0 时拒绝交付。
        usable = [x for x in res if 'detected' in x]
        if not usable:
            print('ENGINES-UNAVAILABLE: 全部引擎报错(未安装/未配置)——'
                  '面杀判定空转, 拒绝交付。先 bootstrap(容器内 '
                  'bootstrap-sandbox.sh 装 clamav/yara)或配置云查 key。')
            return 3
        if not any(x.get('detected') for x in res):
            f_ok, f_note = functest(cur)              # 交付终验:功能门
            pkg = os.path.join(work, 'DELIVERY')
            os.makedirs(pkg, exist_ok=True)
            import shutil; shutil.copy(cur, pkg)
            if not f_ok:
                json.dump({'rounds': r, 'results': res, 'sha256': sha,
                           'functest_pass': False, 'functest_note': f_note,
                           'target_exercise': sc['exercise'], 'verdict': 'AV-CLEAN-FUNCTEST-FAIL'},
                          open(os.path.join(pkg, 'report.json'), 'w'), ensure_ascii=False, indent=1)
                print(f'AV-CLEAN but FUNCTEST FAIL ({f_note}) — 不算通过,如实交付残骸')
                return 1
            # 伪装令交付门禁(2026-09 用户令):任一裸奔面=REJECT,不交付
            dg = subprocess.run(['python3', os.path.join(_data_root(), 'bin/c2-disguise.py'), 'check', '--payload', cur],
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
                        # CS55-F5: 子失败透传(此前裸 run 丢弃)。
                        _rm = subprocess.run([os.path.join(_data_root(), 'bin/c2-variant.py'), 'gen', '--src', cp2, '--out', vo2 + '-m', '--rounds', '2', '--families', 'mask,decomp'],
                                             capture_output=True, text=True)  # CS56-N3: 对齐开括号
                        if _rm.returncode != 0:
                            print(f'c2-variant gen 失败 rc={_rm.returncode}: {(_rm.stderr or _rm.stdout).strip()[:160]}', file=sys.stderr)
                            return 1
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
            # CS55-F5: bind 子失败透传(此前死赋值)。
            b = subprocess.run(['python3', os.path.join(_data_root(), 'bin/c2-bind.py'), 'bind', '--payload', cur],
                               capture_output=True, text=True)
            if b.returncode not in (0, 70):
                print(f'BIND FAIL rc={b.returncode}: {(b.stderr or b.stdout).strip()[:160]}', file=sys.stderr)
                return 1
            v = subprocess.run(['python3', os.path.join(_data_root(), 'bin/c2-bind.py'), 'verify', '--payload', cur],
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
                      open(os.path.join(pkg, 'report.json'), 'w'), ensure_ascii=False, indent=1)
            print(f'PASS after {r} rounds (functest OK, bind {brec.get("target","?")}) → {pkg}')
            return 0
        # 迭代:调变体引擎(签名驱动族+多候选,功能门过滤)
        vo = os.path.join(work, f'v{r}')
        if cur.endswith('.class'):
            # real-lane:字节码变换族(cp-ldc-split)
            # CS55-F5: 子失败透传(此前裸 run 丢弃)。
            _rb = subprocess.run(['python3', os.path.join(_data_root(), 'bin/c2-bytecode.py'), 'split',
                                  '--class', cur, '--out', vo], capture_output=True, text=True)  # CS56-N3
            if _rb.returncode != 0:
                print(f'c2-bytecode split 失败 rc={_rb.returncode}: {(_rb.stderr or _rb.stdout).strip()[:160]}', file=sys.stderr)
                return 1
            cands = []
            mfp = os.path.join(vo, 'manifest.json')
            if os.path.exists(mfp):
                cands = [e['file'] for e in json.load(open(mfp))]  # 绝对路径直用
        else:
            # CS54-F1: 读子进程失败透传(此前死赋值——非族类子失败也被吞)。
            g = subprocess.run([os.path.join(_data_root(), 'bin/c2-variant.py'), 'gen', '--src', cur, '--out', vo,
                                '--rounds', '4', '--families', fams],
                               capture_output=True, text=True)
            if g.returncode != 0:
                print(f'c2-variant gen 失败 rc={g.returncode}: {(g.stderr or g.stdout).strip()[:200]}', file=sys.stderr)
                return 1
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
    # R32D53: -h rc=0(家族统一)。
    if any(x in sys.argv[1:] for x in ('-h', '--help')):  # R32D76-N3: 任意位(对齐 phish 族)
        print(__doc__); return 0
    if len(sys.argv) < 2:
        print(__doc__); return 2
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == 'scan': return cmd_scan(args)
    if cmd == 'run': return cmd_run(args)
    print(__doc__); return 2

if __name__ == '__main__':
    sys.exit(main() or 0)
