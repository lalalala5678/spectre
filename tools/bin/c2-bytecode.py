#!/usr/bin/env python3
"""c2-bytecode — real-lane 字节码变换族(jMG .class 常量池 LDC 分裂)+ 守恒验证。
用法:
  c2-bytecode.py split --class x.class --out dir [--rules /opt/tools/c2/yara-rules]
  c2-bytecode.py verify --orig a.class --mod b.class
  c2-bytecode.py info --class x.class
  c2-bytecode.py selftest          # 对 basetypes-jmg 全量:分裂→yara 清零→守恒验证→容器执行
技术(公开打包图谱):ASM 9 ClassVisitor,visitLdcInsn 命中串 →
  new StringBuilder(a).append(b).toString()  —— 字节码级拼接无 javac 常量折叠,
  运行时字符串值不变,常量池不再含连续明文。
功能守恒判据:
  ① javap -p 成员签名集 原版≡变体(反编译可见核不变)
  ② 加载级:Class.forName(name,false) 解析+链接成功
  ③ 容器执行级:RTHarness listener 模式注册+请求触发无 5xx/无未捕获异常
授权门/EDUSRC 隔离与 c2-qa 同源。
"""
import sys, os, json, subprocess, tempfile, time, hashlib, glob, re


def _data_root():
    """数据根(R32D36 双运行位唯一制式): 容器内 /opt/tools 是 bind 挂载
    (bootstrap 标记识别); 宿主侧 SPECTRE_DATA_DIR。CS23-N9: 此前本工具
    硬编码 /opt/tools 单根——c2-qa 等在宿主位调用时读不到宿主 scope,
    一律 SCOPE-REJECT(75)。"""
    if os.path.exists('/opt/tools/bootstrap-sandbox.sh'):
        return '/opt/tools'
    env = os.environ.get('SPECTRE_DATA_DIR', '')
    if env:
        return os.path.join(env, 'tools')
    print('[warn] SPECTRE_DATA_DIR 未设置, 回退缺省数据根 /var/lib/spectre'
          '(如非本意请先设置 SPECTRE_DATA_DIR)', file=sys.stderr)
    return '/var/lib/spectre/tools'

_C2 = os.path.join(_data_root(), 'c2')
SCOPE = os.path.join(_C2, 'scope.json')
AUDIT = os.path.join(_C2, 'audit.log')
LIBS = os.path.join(_C2, 'libs')
ART = os.path.join(_C2, 'javart')
STUBS = os.path.join(_C2, 'javastubs/classes')
PATCH = os.path.join(_C2, 'javastubs/patchclasses')
SPLITTER = 'CpSplitter'  # 主类名;cp 由调用处拼
DEFAULT_RULES = os.path.join(_C2, 'yara-rules')
JMG_DIR = os.path.join(_C2, 'basetypes-jmg')

def gate():
    if not os.path.exists(SCOPE):
        print('SCOPE-REJECT'); sys.exit(75)
    sc = json.load(open(SCOPE))
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    if not (sc.get('targets') and sc['window']['start'] <= now <= sc['window']['end']):
        print('SCOPE-REJECT'); sys.exit(75)
    ev = os.environ.get('SPECTRE_EDUSRC', '')
    if ev.lower() in ('1', 'true', 'yes') or 'edusrc' in (os.getcwd() + ' ' + ev).lower():
        print('EDUSRC-REJECT'); sys.exit(76)
    return sc

def audit(action, note):
    with open(AUDIT, 'a') as f:
        f.write(f'{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}\tBYTECODE\t{action}\t{note}\n')

def sha256f(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()

def yara_hits(path, rules_dir):
    """[(string, offset)] 所有规则文件的命中串。"""
    hits = []
    for rf in sorted(glob.glob(rules_dir + '/*.yar') + glob.glob(rules_dir + '/*.yara')):
        import shutil
        if not shutil.which('yara'):
            print('[c2-bytecode] yara 不在 PATH——跳过规则扫描(容器位内置; 宿主自装或容器位运行)', file=sys.stderr)
            return 0, []
        r = subprocess.run(['yara', '-s', rf, path], capture_output=True, text=True, timeout=60)
        for line in r.stdout.splitlines():
            m = re.match(r'^(0x[0-9a-fA-F]+):(\$[\w]+): ?(.*)$', line)
            if m:
                hits.append((m.group(3), int(m.group(1), 16)))
    return hits

def this_class_name(path):
    """极简常量池解析:取 this_class 的类名(slashed)。"""
    b = open(path, 'rb').read()
    if b[:4] != b'\xca\xfe\xba\xbe':
        return None
    i = 10
    n = int.from_bytes(b[8:10], 'big')
    cps = {}
    idx = 1
    while idx < n:
        tag = b[i]
        if tag == 1:
            ln = int.from_bytes(b[i + 1:i + 3], 'big')
            cps[idx] = b[i + 3:i + 3 + ln].decode('utf-8', 'replace')
            i += 3 + ln
        elif tag in (7, 8, 16, 19, 20):
            cps[idx] = int.from_bytes(b[i + 1:i + 3], 'big'); i += 3
        elif tag == 15:
            i += 4
        elif tag in (3, 4, 9, 10, 11, 12, 17, 18):
            i += 5
        elif tag in (5, 6):
            i += 9; idx += 1
        else:
            return None
        idx += 1
    # this_class = cp[idx_of(类常量)]:跳过 access_flags 等需要精确定位——简化:找 cp[7] 引用
    try:
        return cps.get(cps.get(this_class_off(b, cps, i)), '?')
    except Exception:
        return '?'

def this_class_off(b, cps, i):
    # i 现指向 cp 结束后的 access_flags;this_class 在其后
    acc_len = 2
    off = int.from_bytes(b[i + acc_len:i + acc_len + 2], 'big')
    return off

def javap_sigs(path):
    r = subprocess.run(['javap', '-p', path], capture_output=True, text=True, timeout=60)
    return sorted(l.strip() for l in r.stdout.splitlines()
                  if l.strip() and not l.startswith(('Compiled from', 'public class', 'class '))
                  or l.startswith(('public class', 'class')) and ';' in l)

def javap_members(path):
    """成员签名集(构造器/方法/字段声明行,与常量池地址无关)。"""
    r = subprocess.run(['javap', '-p', path], capture_output=True, text=True, timeout=60)
    return sorted(l.strip().rstrip('{').strip()
                  for l in r.stdout.splitlines()
                  if ('(' in l or l.strip().endswith(';')) and 'class ' not in l and l.strip())

def cmd_info(args):
    a = dict(zip(args[::2], args[1::2]))
    n = this_class_name(a['--class'])
    print(json.dumps({'file': a['--class'], 'this_class': n,
                      'sha256': sha256f(a['--class'])[:16]}, ensure_ascii=False))
    return 0

def cmd_split(args):
    sc = gate()
    a = dict(zip(args[::2], args[1::2]))
    rules = a.get('--rules', DEFAULT_RULES)
    src = a['--class']
    outdir = a.get('--out') or tempfile.mkdtemp(prefix='c2bc-')
    os.makedirs(outdir, exist_ok=True)
    hits = yara_hits(src, rules)
    if not hits:
        print('SPLIT-SKIP: no yara hits'); return 0
    sigs = sorted({h[0] for h in hits if h[0] and len(h[0]) >= 2})
    tf = os.path.join(outdir, 'targets.txt')
    open(tf, 'w').write('\n'.join(sigs))
    cn = this_class_name(src) or os.path.splitext(os.path.basename(src))[0]
    dst = os.path.join(outdir, *cn.split('/')) + '.class'
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    r = subprocess.run(['java', '-cp', f'{LIBS}/asm-9.7.jar:{ART}', SPLITTER, src, dst, tf],
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0 or 'CPSPLIT-OK' not in r.stdout:
        print('SPLIT-FAIL: ' + (r.stdout + r.stderr).strip()[:160]); return 1
    resid = yara_hits(dst, rules)
    m2 = re.search(r'rewritten=\[(.*?)\]', r.stdout)
    rw = set(x.strip() for x in m2.group(1).split(',')) if m2 else set()
    rec = {'file': dst, 'sha256': sha256f(dst), 'family': 'cp-ldc-split(ASM9)',
           'targets': sigs, 'rewritten_ldc': sorted(rw),
           'hits_before': len(hits), 'hits_after': len(resid),
           'residual': sorted({h[0] for h in resid}),
           'residual_structural': sorted({h[0] for h in resid} - rw)}
    mf = os.path.join(outdir, 'manifest.json')
    m = json.load(open(mf)) if os.path.exists(mf) else []
    m.append(rec); json.dump(m, open(mf, 'w'), indent=1)
    audit('split', f'{os.path.basename(src)}\t{rec["sha256"][:16]}\t{len(hits)}->{len(resid)}')
    print(json.dumps(rec, ensure_ascii=False))
    return 0


def _rt_cp():
    """RTHarness 运行时 classpath 单源(CS26-1: 此前两处孪生串, AN 的
    count=1 替换只落一处留下 P0 丢冒号粘连)。"""
    jmg = os.path.join(_C2, 'generators/jmg-all-1.0.9_250101.jar')
    return (f'{LIBS}/tomcat-embed-core-9.0.106.jar:{LIBS}/annotations-api-6.0.53.jar'
            f':{jmg}:{ART}:{STUBS}')

def _load_result(classfile):
    cn = this_class_name(classfile)
    fq = (cn or '?').replace('/', '.')
    d = os.path.dirname(os.path.abspath(classfile))
    r = subprocess.run(['java', '--patch-module', f'jdk.unsupported={PATCH}',
                        '-cp', _rt_cp() + f':{d}',
                        'RTHarness', 'load', fq, ''], capture_output=True, text=True, timeout=120)
    line = [l for l in r.stdout.splitlines() if l.startswith('RT-RESULT')]
    return ('OK' if r.returncode == 0 else 'FAIL',
            line[0].split('detail=', 1)[-1][:110] if line else r.stdout[-110:])

def cmd_verify(args):
    a = dict(zip(args[::2], args[1::2]))
    o, m = a['--orig'], a['--mod']
    sig_ok = javap_members(o) == javap_members(m)
    # 等价守恒:变体加载行为必须与原版一致(都成/同因失败)——
    # jMG 生成物自带伪装伴生类依赖,其加载失败与变换无关,等价即守恒
    lo, do = _load_result(o)
    lm, dm = _load_result(m)
    equiv = (lo == lm) and (do == dm)
    rec = {'member_signatures_equal': sig_ok,
           'load_orig': lo, 'load_mod': lm, 'load_equivalent': equiv,
           'detail_orig': do, 'detail_mod': dm}
    if '--exec' in a:  # 可选容器执行(自证型载荷用)
        rec['exec'] = rt_exec(m)
    print(json.dumps(rec, ensure_ascii=False))
    return 0 if (sig_ok and equiv) else 1

def rt_exec(classfile):
    cn = this_class_name(classfile)
    fq = (cn or '?').replace('/', '.')
    d = os.path.dirname(os.path.abspath(classfile))
    r = subprocess.run(['java', '--patch-module', f'jdk.unsupported={PATCH}',
                        '-cp', _rt_cp() + f':{d}',
                        'RTHarness', 'listener', fq, ''], capture_output=True, text=True, timeout=120)
    line = [l for l in r.stdout.splitlines() if l.startswith('RT-RESULT')]
    return r.returncode, (line[0] if line else r.stdout[-160:])

def cmd_selftest(args):
    sc = gate()
    fails = 0
    for f in sorted(glob.glob(JMG_DIR + '/*.class')):
        out = tempfile.mkdtemp(prefix='c2bc-st-')
        g = subprocess.run([sys.executable, os.path.abspath(__file__), 'split', '--class', f, '--out', out],
                           capture_output=True, text=True)
        try:
            mod = json.load(open(os.path.join(out, 'manifest.json')))[-1]['file']
        except Exception:
            print(f'SELFTEST FAIL {os.path.basename(f)}: split failed: {g.stdout.strip()[:80]}')
            fails += 1; continue
        resid = yara_hits(mod, DEFAULT_RULES)
        v = subprocess.run([sys.executable, os.path.abspath(__file__), 'verify', '--orig', f, '--mod', mod],
                           capture_output=True, text=True)
        # RealLaneProbe:等价+容器执行+回显;其余(jMG 生成物):等价(其伴生类依赖与变换无关)
        probe = 'RealLaneProbe' in f
        mf = json.load(open(os.path.join(out, 'manifest.json')))[-1]
        resid = set(h[0] for h in resid)
        ldc_clean = resid.isdisjoint(set(mf.get('rewritten_ldc', [])))
        ok = ldc_clean and v.returncode == 0
        extra = ''
        if probe:
            rc_rt, rt_line = rt_exec(mod)
            ok = ok and rc_rt == 0
            extra = f' rt={rc_rt} {rt_line[:70]}'
        print(f"SELFTEST {'OK  ' if ok else 'FAIL'} {os.path.basename(f)}: ldc面清零={ldc_clean} 结构残留={sorted(resid)} verify(equiv)={v.returncode}{extra}")
        fails += 0 if ok else 1
    print(f'SELFTEST SUMMARY: {fails} fail')
    return 1 if fails else 0

def main():
    # CS27-9: -h/--help rc=0(与 javart/functest/payload-spec 家族统一)。
    if len(sys.argv) >= 2 and sys.argv[1] in ('-h', '--help'):
        print(__doc__); return 0
    if len(sys.argv) < 2:
        print(__doc__); return 2
    cmd, args = sys.argv[1], sys.argv[2:]
    return {'split': cmd_split, 'verify': cmd_verify, 'info': cmd_info,
            'selftest': cmd_selftest}.get(cmd, lambda a: (print(__doc__), 2)[1])(args)

if __name__ == '__main__':
    sys.exit(main() or 0)
