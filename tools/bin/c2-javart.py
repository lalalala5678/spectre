#!/usr/bin/env python3
"""c2-javart — Java 运行时验证包装(嵌入式 Tomcat 9 桩,/opt/tools/c2/javart/RTHarness)。
用法:
  c2-javart.py --src variant.java             # 源码 → 编译 → 模式探测 → RT
  c2-javart.py --class x.class --name fqcn    # real-lane:class 文件 → load/注册模式
判定:exit 0=RT OK;1=编译失败;3=RT 失败(注册/触发/标记缺失/5xx)
模式探测(基于 \\uXXXX 解转义后的源码):
  implements ServletRequestListener → listener(真事件触发)
  implements Filter                 → filter(真过滤链)
  extends HttpServlet               → servlet(真映射+POST)
  @RequestMapping                   → annotation(反射验证 RUNTIME 注解)
  其它(如 HandlerInterceptor)     → load(加载+链接级)
"""
import sys, os, re, subprocess, tempfile, shutil


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
LIBS = os.path.join(_C2, 'libs')
STUBS = os.path.join(_C2, 'javastubs/classes')
PATCH = os.path.join(_C2, 'javastubs/patchclasses')
ART = os.path.join(_C2, 'javart')
TC9 = f'{LIBS}/tomcat-embed-core-9.0.106.jar:{LIBS}/annotations-api-6.0.53.jar'
TC10 = f'{LIBS}/tomcat-embed-core-10.1.42.jar:{LIBS}/jakarta.annotation-api-2.1.1.jar'
STUBS_J = os.path.join(_C2, 'javastubs-jakarta/classes')
SPRING = ':'.join(os.path.join(_C2, p) for p in [
    'libs/spring/spring-webmvc-6.0.9.jar', 'libs/spring/spring-web-6.0.9.jar',
    'libs/spring/spring-core-6.0.9.jar', 'libs/spring/spring-context-6.0.9.jar',
    'libs/spring/spring-beans-6.0.9.jar', 'libs/spring/spring-expression-6.0.9.jar',
    'libs/spring/spring-aop-6.0.9.jar', 'libs/spring/spring-jcl-6.0.9.jar',
    'libs/tomcat-embed-core-10.1.42.jar'])  # CS24-F2: 双根化
RXSTUB = os.path.join(_C2, 'javastubs-rx/classes')

def extra_cp(logical):
    e = []
    if 'org.springframework' in logical: e.append(SPRING)
    if 'reactor.core.publisher' in logical or 'web.reactive' in logical: e.append(RXSTUB)
    return ':'.join(e)

def unescape(s):
    return re.sub(r'\\u([0-9a-fA-F]{4})', lambda x: chr(int(x.group(1), 16)), s)

def detect_mode(logical):
    if 'catalina.Valve' in logical: return 'valve', 'SPECTRE-MARK-VALVE'
    if 'HttpUpgradeHandler' in logical: return 'upgrade', 'SPECTRE-MARK-UPGRADE'
    if re.search(r'implements\s+[\w.]*ServletRequestListener', logical): return 'listener', 'SPECTRE-MARK-LISTENER'
    if re.search(r'implements\s+[\w.]*\.?Filter\b', logical) or 'doFilter' in logical: return 'filter', 'SPECTRE-MARK-FILTER'
    if re.search(r'extends\s+[\w.]*HttpServlet', logical): return 'servlet', 'SPECTRE-MARK-SERVLET'
    if 'RequestMapping' in logical: return 'annotation', ''   # 注解反射即判据,免标记
    m = re.search(r'public\s+class\s+(\w+)', logical)
    return 'load', (m.group(1) if m else '')

def lane_of(logical):
    return 'jakarta' if 'jakarta.' in logical else 'javax'

def compile_src(src_path, outdir):
    src = open(src_path, errors='replace').read()
    logical = unescape(src)
    m = re.search(r'public\s+class\s+((?:\\u[0-9a-fA-F]{4}|[A-Za-z0-9_$])+)', logical) or \
        re.search(r'\bclass\s+((?:\\u[0-9a-fA-F]{4}|[A-Za-z0-9_$])+)', logical)
    if not m:
        return None, 'no-class-decl'
    name = m.group(1)
    tmp = os.path.join(outdir, name + '.java')
    shutil.copy(src_path, tmp)
    lane = lane_of(logical)
    tc = TC10 if lane == 'jakarta' else TC9
    stub_cp = f'{STUBS_J}:{STUBS}' if lane == 'jakarta' else STUBS
    xc = extra_cp(logical)
    cmd = ['javac', '-encoding', 'UTF-8', '-cp', f'{tc}:{stub_cp}' + (':' + xc if xc else ''), '-d', outdir, tmp]
    if 'sun.misc' in logical:
        cmd[1:1] = ['--patch-module',
                'jdk.unsupported=' + os.path.join(_C2, 'javastubs/patchsrc')]  # CS24-F2/N4
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        return None, 'javac:' + (r.stdout + r.stderr).strip()[:120]
    return name, logical

def run_harness(mode, name, marker, cp_extra, lane='javax'):
    tc = TC10 if lane == 'jakarta' else TC9
    harness = 'RTHarnessJakarta' if lane == 'jakarta' else 'RTHarness'
    stub_cp = f'{STUBS_J}:{STUBS}' if lane == 'jakarta' else STUBS
    cmd = ['java', '--patch-module', f'jdk.unsupported={PATCH}',
           '-cp', f'{tc}:{ART}:{stub_cp}:{cp_extra}', harness, mode, name, marker or '']
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    line = [l for l in r.stdout.splitlines() if l.startswith('RT-RESULT:')]
    return r.returncode, (line[0] if line else (r.stdout + r.stderr).strip()[:160])

def main():
    args = sys.argv[1:]
    # R32D42-P1/P2: --help/奇数参不再裸栈
    if not args or args[0] in ('-h', '--help'):
        print(__doc__); return 0 if args else 2
    if len(args) % 2:
        print(f'[c2-javart] 参数须为键值对(收到奇数个): {args}', file=sys.stderr); return 2
    a = dict(zip(args[::2], args[1::2]))
    d = tempfile.mkdtemp(prefix='c2javart-')
    try:
        if '--src' in a:
            name, logical = compile_src(a['--src'], d)
            if not name:
                print(f'RT-COMPILE-FAIL: {logical}'); return 1
            mode, marker = detect_mode(logical)
            xc = extra_cp(logical)
            rc, line = run_harness(mode, name, marker, d + (':' + xc if xc else ''), lane_of(logical))
        else:
            cls = a['--class']
            outd = os.path.dirname(os.path.abspath(cls)) or '.'
            name = a.get('--name') or os.path.splitext(os.path.basename(cls))[0]
            logical = name  # class 模式由调用方给 fqcn/短名;load 用短名,cp 加目录
            mode = a.get('--mode', 'load')
            rc, line = run_harness(mode, name, a.get('--mark', ''), outd)
        print(f'RT[{mode}] {"OK" if rc == 0 else "FAIL"}: {line}')
        return rc
    finally:
        shutil.rmtree(d, ignore_errors=True)

if __name__ == '__main__':
    sys.exit(main() or 0)
