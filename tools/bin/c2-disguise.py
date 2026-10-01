#!/usr/bin/env python3
"""c2-disguise — 全面伪装令核查器(2026-09 用户令,交付门禁组件)。
用法:
  c2-disguise.py check --payload p            # 单载荷四条核查
  c2-disguise.py check --delivery DIR         # 交付包核查(载荷+connect-info)
  c2-disguise.py normalize <file>             # 输出值归一化视图(解转义+重拼接,审计用)
四条判据(任一 FAIL=裸奔=REJECT):
  ① 密钥材料:禁公开默认密钥/口令(值归一化后扫描)
  ② 文件名/类名:禁 payload|shell|memshell|cmd|connect|backdoor|webshell 字样;
     要求语义中性伪装(业务化命名池)
  ③ 请求路径:路径串禁 cmd|shell|connect;要求拟业务路由(/api/log/report 形)
  ④ 字段/参数名:请求字段名禁 cmd|shell|connect;UA/Header/Content-Type 面
     (载荷侧无该面时报 N/A;有则必须业务化)
值归一化:\\uXXXX 解转义 + "a"+"b" / 'a'.'b' 拼接还原(防拆分/转义规避检测)。
"""
import sys, os, re, json, glob
from _common import edusrc_gate

BANNED_WORDS = ['payload', 'shell', 'memshell', 'cmd', 'connect', 'backdoor', 'webshell', 'ghost', 'ice', 'behinder', 'godzilla']
# ===== 二令·深度伪装十四项(面盘点:面在=必查,面缺=N/A 留痕) =====
DEEP_FACES = {
 'tls_client':   r'SSLSocketFactory|HttpsURLConnection|SSLContext\.getInstance|tls\.Dial',
 'h2_client':    r'Http2Client|HTTP2?_\?SETTINGS|net/http2|HttpClient\.newBuilder',
 'heartbeat':    r'Thread\.sleep|setTimeout\(.*poll|while\s*\(\s*true\s*\)',
 'resp_face':    r'getWriter\(\)\.write|echo\s|Write-Output',   # stdout println=内部调试面不计
 'thread_spawn': r'new Thread\s*\(',
 'stacktrace':   r'printStackTrace|StackTrace\(\)|debug_print_backtrace',
 'error_face':   r'sendError\(|setStatus\(4|setStatus\(5',
 'persist_face': r'Registry|RunKey|schtasks|systemctl|crontab|LaunchAgent',
}

def class_banned(cn):
    """禁词类名判定:驼峰分词;长词(≥7)子串,短歧义词整词——防 ice/service 误报。"""
    import re as _re
    low = str(cn).lower()
    toks = [t.lower() for t in _re.findall(r'[A-Z]?[a-z]+|[A-Z]+(?![a-z])', str(cn))]
    long_w = [w for w in BANNED_WORDS if len(w) >= 7]
    short_w = [w for w in BANNED_WORDS if len(w) < 7]
    if any(w in low for w in long_w):
        return True
    return any(w in toks for w in short_w)

DEFAULT_KEYS = [
    'e45e329feb5d925b',   # 冰蝎默认 key md5("rebeyond")[:16]
    '3c6e0b8a9c15224a',   # 哥斯拉默认
    'rebeyond',            # 冰蝎默认 pass
    'key321',
    'xdmdtmtk',            # 哥斯拉旧默认
]
FIELD_BANNED = ['cmd', 'shell', 'connect', 'exec', 'payload']
PATH_BANNED = ['cmd', 'shell', 'connect', 'exec', 'payload']

def normalize(src):
    """值归一化:\\uXXXX 解转义 → 拼接运算符重join(仅用于检测,不还原语义)。"""
    s = re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)), src)
    # "aaa" + "bbb" → aaabbb / 'aaa'.'bbb' → aaabbb / "aaa" . "bbb"
    prev = None
    while prev != s:
        prev = s
        s = re.sub(r'(["\'])((?:(?!\1).)*)\1\s*(?:\+|\.)\s*(["\'])((?:(?!\3).)*)\3',
                   lambda m: '"' + m.group(2) + m.group(4) + '"', s)
    return s

def check_payload(path):
    raw = open(path, errors='replace').read()
    nrm = normalize(raw)
    low = nrm.lower()
    name = os.path.basename(path)
    r = {'file': path, 'filename': name}

    # ① 密钥材料
    hits = [k for k in DEFAULT_KEYS if k in low]
    r['key_material'] = {'verdict': 'FAIL' if hits else 'PASS', 'hits': hits}

    # ② 文件名/类名
    fn_stem = re.sub(r'\.[A-Za-z0-9]+$', '', name)
    fn_bad = []
    if class_banned(fn_stem):
        fn_bad = ['<filename-banned:%s>' % fn_stem]
    cls = re.findall(r'class\s+([A-Za-z_]\w*)', nrm)
    cls_bad = [c for c in cls if class_banned(c)]
    semantic = any(re.search(p, name, re.I) for p in
                   [r'helper|util|report|session|log|config|trace|encoding|update|cleanup|task|service|api|common|handler'])
    r['naming'] = {'verdict': 'FAIL' if (fn_bad or cls_bad) else ('WARN' if not semantic and not name.endswith('.class') else 'PASS'),
                   'filename_banned': fn_bad, 'class_banned': cls_bad,
                   'classes': cls[:4], 'semantic': semantic}

    # ③ 请求路径(引号内以 / 开头的路由串)
    paths = re.findall(r'[\'"](/[A-Za-z0-9_\-/.]{1,60})[\'"]', nrm)
    bad_paths = [p for p in paths if any(w in p.lower() for w in PATH_BANNED)]
    biz_paths = [p for p in paths if re.match(r'/api/|/v\d/|/log|/report|/session|/static|/health|/task', p, re.I)]
    r['request_path'] = {'verdict': 'FAIL' if bad_paths else ('WARN' if paths and not biz_paths else ('PASS' if paths else 'N/A')),
                         'paths': paths[:6], 'banned': bad_paths}

    # ④ 字段/参数名 + UA/Header/Content-Type 面
    fields = set(re.findall(r"\[\s*['\"]([\w\-]{1,24})['\"]\s*\]", nrm)) | \
             set(re.findall(r"get(?:OrDefault)?\(\s*['\"]([\w\-]{1,24})['\"]", nrm))
    bad_fields = [f for f in fields if f.lower() in FIELD_BANNED]
    has_http_face = bool(re.search(r'setRequestProperty|User-Agent|Content-Type|header|Header', nrm))
    r['fields'] = {'verdict': 'FAIL' if bad_fields else 'PASS', 'fields': sorted(fields)[:8], 'banned': bad_fields}
    r['http_face'] = {'present': has_http_face,
                      'verdict': 'N/A' if not has_http_face else 'CHECK',
                      'note': '载荷含 HTTP 客户端面:UA/Header/Content-Type 须业务化(交付时人工/协议模板核)'}

    r['deep'] = check_deep(raw, nrm, path)
    deep_fail = [k for k, v in r['deep'].items() if v.get('verdict') == 'FAIL']
    hard = [k for k, v in r.items() if isinstance(v, dict) and v.get('verdict') == 'FAIL'] + deep_fail
    r['verdict'] = 'REJECT' if hard else 'ACCEPT'
    r['bare_surfaces'] = hard
    return r

def check_deep(raw, nrm, path):
    """二令十四项:面在=判据,面缺=N/A(留痕);判据不满足=FAIL(裸奔)。"""
    import re as _re  # CS28: _os/_struct 死别名删
    out = {}
    def face(name):
        return bool(_re.search(DEEP_FACES[name], raw))
    # ① JA3/JA4:出站 TLS 面在=须随附套件序配置(deploy-checklist/连接材料),否则 FAIL
    if face('tls_client'):
        out['ja3_ja4'] = {'present': True, 'verdict': 'FAIL',
                          'note': '出站 TLS 面在:须 Chrome 套件序配置随交付(deploy-checklist.tls.cipher_order),禁默认 Go/Java 栈'}
    else:
        out['ja3_ja4'] = {'present': False, 'verdict': 'N/A'}
    # ② H2 SETTINGS
    out['h2_settings'] = {'present': face('h2_client'),
                          'verdict': ('FAIL' if face('h2_client') else 'N/A'),
                          'note': 'H2 面在须 SETTINGS 帧拟态配置' if face('h2_client') else ''}
    # ③ 心跳 jitter
    if face('heartbeat'):
        has_jitter = bool(_re.search(r'random|Random|jitter|nextDouble|rand\(', raw))
        out['heartbeat_jitter'] = {'present': True, 'verdict': 'PASS' if has_jitter else 'FAIL',
                                   'note': '心跳面在须 ±30% 随机化因子'}
    else:
        out['heartbeat_jitter'] = {'present': False, 'verdict': 'N/A'}
    # ④+⑦ 响应面:业务 JSON 包裹+随机填充
    if face('resp_face'):
        jsonish = bool(_re.search(r'\{[\s\S]{0,80}"(code|msg|message|data|status|request_id)"[\s\S]{0,120}\}', raw)) or                   'json_encode' in raw or 'UUID.randomUUID' in raw
        out['resp_wrap'] = {'present': True, 'verdict': 'PASS' if jsonish else 'FAIL',
                            'note': '响应面在:须业务 JSON 包裹+随机字段(长度填充)'}
    else:
        out['resp_wrap'] = {'present': False, 'verdict': 'N/A'}
    # ⑤ 流量体积曲线:beacon/loop 面在须曲线配置;静态骨架 N/A
    out['volume_curve'] = {'present': face('heartbeat'),
                           'verdict': ('CHECK' if face('heartbeat') else 'N/A'),
                           'note': '空闲/饱和体积分布拟业务曲线(deploy-checklist.flow_curve)'}
    # ⑥ 线程名+异常栈
    if face('thread_spawn'):
        neutral = bool(_re.search(r'setName\(\s*"(worker|pool|task|job|session|report)[\w-]*"', raw))
        out['thread_hygiene'] = {'present': True, 'verdict': 'PASS' if neutral else 'FAIL',
                                 'note': '线程面在:名须中性化'}
    else:
        out['thread_hygiene'] = {'present': False, 'verdict': 'N/A'}
    if face('stacktrace'):
        out['stack_swallow'] = {'present': True, 'verdict': 'FAIL',
                                'note': 'printStackTrace 泄栈=裸奔(须吞净改日志面)'}
    else:
        out['stack_swallow'] = {'present': False, 'verdict': 'PASS'}
    # ⑧ 错误文案
    if face('error_face'):
        out['error_mimic'] = {'present': True, 'verdict': 'CHECK',
                              'note': '错误面在:文案须复制目标应用(deploy-checklist.error_pages)'}
    else:
        out['error_mimic'] = {'present': False, 'verdict': 'N/A'}
    # ⑨ mtime(交付级,check_delivery 处理)——单文件层留 N/A
    out['mtime_mimic'] = {'present': True, 'verdict': 'CHECK', 'note': '交付打包时按目录均值伪装(qa 已接)'}
    # ⑩ 持久化项
    if face('persist_face'):
        syslike = bool(_re.search(r'(Microsoft|Windows|System|Update|Telemetry|JavaUpdate|OneSync)', raw))
        out['persist_naming'] = {'present': True, 'verdict': 'PASS' if syslike else 'FAIL'}
    else:
        out['persist_naming'] = {'present': False, 'verdict': 'N/A'}
    # ⑪ PE 资源段
    if path.lower().endswith(('.exe', '.dll')):
        out['pe_resources'] = {'present': True, 'verdict': 'CHECK',
                               'note': 'PE 交付须图标/公司名/版本段(脚本级校验待 PE 车道)'}
    else:
        out['pe_resources'] = {'present': False, 'verdict': 'N/A'}
    # ⑫ jar MANIFEST
    if path.lower().endswith('.jar'):
        out['manifest_neutral'] = {'present': True, 'verdict': 'CHECK', 'note': 'JAR 交付:MANIFEST 属性查禁词+中性化'}
    else:
        out['manifest_neutral'] = {'present': False, 'verdict': 'N/A'}
    # ⑬ 旅程拟态
    out['journey'] = {'present': face('heartbeat') or face('tls_client'),
                      'verdict': ('CHECK' if (face('heartbeat') or face('tls_client')) else 'N/A'),
                      'note': '请求序列先静态资源后 API(操作员侧执行纪律)'}
    # ⑭ 部署清单:交付级检查(check_delivery)
    out['deploy_checklist'] = {'present': True, 'verdict': 'CHECK',
                               'note': '交付包应含 deploy-checklist 引用(模板+校验脚本已出)'}
    return out

GOVERNANCE_FILES = {'deploy-checklist.yaml', 'check-deploy.sh', 'report.json',
                    'connect-info.json', 'NONCOMPLIANT.json', 'SUPERSEDED.json',
                    'VOID.json', 'disguise-reject.json'}   # 治理/元数据文件不当载荷扫

def check_delivery(d):
    payloads = [f for f in glob.glob(os.path.join(d, '*'))
                if os.path.isfile(f)
                and os.path.basename(f) not in GOVERNANCE_FILES
                and not f.endswith('.bind.json')]
    out = {'delivery': d, 'items': [], 'connect_info': os.path.exists(os.path.join(d, 'connect-info.json'))}
    for p in payloads:
        out['items'].append(check_payload(p))
    bare = [i['file'] for i in out['items'] if i['verdict'] == 'REJECT']
    # ⑨ mtime 拟态核查:交付文件 mtime 偏离目录均值过大=裸奔
    import statistics as _st  # CS28: _t 死别名删
    files = [f for f in glob.glob(os.path.join(d, '*')) if os.path.isfile(f)]
    mt = [os.path.getmtime(f) for f in files]
    out['mtime'] = {'n': len(mt),
                    'verdict': 'PASS' if (len(mt) < 2 or _st.pstdev(mt) < 3600) else 'FAIL',
                    'note': 'mtime 与目录均值偏差<1h'}
    # ⑭ 部署清单(二令第十四项,交付包必备):缺=裸奔面
    out['deploy_checklist'] = os.path.exists(os.path.join(d, 'deploy-checklist.yaml'))
    out['deploy_check_script'] = os.path.exists(os.path.join(d, 'check-deploy.sh'))
    bare14 = [] if (out['deploy_checklist'] and out['deploy_check_script']) else ['deploy_checklist(⑭)']
    out['verdict'] = 'REJECT' if (bare or out['mtime']['verdict'] == 'FAIL' or bare14) else 'ACCEPT'
    out['bare_surfaces'] = (out.get('bare_surfaces') or []) + bare14
    out['note'] = ('密钥材料须随 connect-info.json' if not out['connect_info'] else '')
    return out

def main():
    # CS27-9: -h/--help rc=0(家族统一)。
    if len(sys.argv) >= 2 and sys.argv[1] in ('-h', '--help'):
        print(__doc__); return 0
    # R32D62-P3/CS41-A4: env-only EDUSRC 门, 序=门先于子命令用法。
    edusrc_gate()
    if len(sys.argv) < 3:
        print(__doc__); return 2
    cmd, args = sys.argv[1], sys.argv[2:]
    a = dict(zip(args[::2], args[1::2]))
    if cmd == 'check':
        # CS41-A9: 缺参干净 rc=2(此前 KeyError 裸栈)。
        if '--delivery' not in a and '--payload' not in a:
            print('用法: c2-disguise.py check --payload <file> | --delivery <dir>', file=sys.stderr); return 2
        res = check_delivery(a['--delivery']) if '--delivery' in a else check_payload(a['--payload'])
        print(json.dumps(res, ensure_ascii=False, indent=1))
        return 1 if res['verdict'] == 'REJECT' else 0
    if cmd == 'normalize':
        # CS41-A9: 文件参缺/不存在干净 rc=2(此前 KeyError/裸栈)。
        fn = a.get('<file>') or (args[0] if args else '')
        if not fn or not os.path.isfile(fn):
            print(f'用法: c2-disguise.py normalize <file>——文件不存在或未给出: {fn!r}', file=sys.stderr); return 2
        print(normalize(open(fn).read())[:2000])
        return 0
    print(__doc__); return 2

if __name__ == '__main__':
    sys.exit(main() or 0)
