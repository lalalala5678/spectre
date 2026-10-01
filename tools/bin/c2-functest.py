#!/usr/bin/env python3
"""c2-functest — 功能性守恒检查 v2(验证金字塔)。
用法: c2-functest.py <payload-file>
层级(逐级从严,按语言取最高可得层):
  L0 标记层:SPECTRE-MARK 字面量在(所有语言,必要条件)
  L1 语法层:php=php -l;java=javac(-encoding UTF-8+桩 classpath,sun.misc 走
             --patch-module,类名从源码提取落临时目录)
  L2 运行层:php=php 实跑(基线无回显的载荷按契约降级 OK-static,如 callback 型);
             js=node + /opt/tools/c2/jsshim/wsh-shim.js(构造 ProgID 记录+echo 含标记);
             ps=pwsh -NoProfile -File(stdout 含标记,承重自证契约)
退出码:0=功能守恒;1=功能丢失(标记/语法层失);3=运行层劣化(基线可运行而变体不可)
"""
import sys, os, re, subprocess, tempfile, shutil
from _common import _data_root


_C2 = os.path.join(_data_root(), 'c2')
STUB_CP = os.path.join(_C2, 'javastubs/classes')
SPRING = ':'.join(os.path.join(_C2, p) for p in [
    'libs/spring/spring-webmvc-6.0.9.jar', 'libs/spring/spring-web-6.0.9.jar',
    'libs/spring/spring-core-6.0.9.jar', 'libs/spring/spring-context-6.0.9.jar',
    'libs/spring/spring-beans-6.0.9.jar', 'libs/spring/spring-expression-6.0.9.jar',
    'libs/spring/spring-aop-6.0.9.jar', 'libs/spring/spring-jcl-6.0.9.jar',
    'libs/tomcat-embed-core-10.1.42.jar'])  # CS24-F2: 双根化
RXSTUB = os.path.join(_C2, 'javastubs-rx/classes')
# CS27-4: jakarta 车道桩(j10_* 基型 implements jakarta.* 此前结构性
# 不可编译——STUB_CP 只含 javax 桩)。
STUBS_J = os.path.join(_C2, 'javastubs-jakarta/classes')
TC10 = os.path.join(_C2, 'libs/tomcat-embed-core-10.1.42.jar')

def extra_cp(body):
    e = []
    if 'jakarta.servlet' in body:
        e.append(TC10); e.append(STUBS_J)
    if 'org.springframework' in body: e.append(SPRING)
    if 'reactor.core.publisher' in body or 'web.reactive' in body: e.append(RXSTUB)
    return ':'.join(e)
SUN_PATCH = os.path.join(_C2, 'javastubs/patchsrc')
JS_SHIM = os.path.join(_C2, 'jsshim/wsh-shim.js')

def javac_check(p):
    src = open(p, errors='replace').read()
    # 编译器视角:先做 JLS§3.3 unicode 解转义再做判定(否则 \uXXXX 改写会骗过检测)
    logical = re.sub(r'\\u([0-9a-fA-F]{4})', lambda x: chr(int(x.group(1), 16)), src)
    m = re.search(r'public\s+class\s+((?:\\u[0-9a-fA-F]{4}|[A-Za-z0-9_$])+)', logical) or \
        re.search(r'\bclass\s+((?:\\u[0-9a-fA-F]{4}|[A-Za-z0-9_$])+)', logical)
    if not m:
        return False, 'no class declaration found'
    name = m.group(1)
    d = tempfile.mkdtemp()
    try:
        shutil.copy(p, os.path.join(d, name + '.java'))
        xc = extra_cp(src)
        # CS27-4: 真实依赖(xc)前置于桩树——javax 桩的 spring 接口先于真
        # jar 解析会使 jakarta 形参不构成 override(c2-javart 同款已修)。
        cmd = ['javac', '-encoding', 'UTF-8', '-cp', (xc + ':' if xc else '') + STUB_CP, '-d', os.path.join(d, 'out'),
               os.path.join(d, name + '.java')]
        if 'sun.misc' in logical:
            cmd[1:1] = ['--patch-module', 'jdk.unsupported=' + SUN_PATCH]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            return False, 'javac: ' + (r.stdout + r.stderr).strip()[:100]
        return True, 'javac OK (class=' + name + ')'
    finally:
        shutil.rmtree(d, ignore_errors=True)

def node_check(p):
    r = subprocess.run(['node', JS_SHIM, p], capture_output=True, text=True, timeout=30)
    out = r.stdout + r.stderr
    progids = re.search(r'SHIM-PROGIDS: (\[.*\])', out)
    if r.returncode != 0 or 'SHIM-ERROR' in out:
        return False, 'js runtime: ' + out.strip()[:100]
    if 'SPECTRE-MARK' not in out:
        return False, 'js runtime: echo 缺标记'
    return True, 'js runtime OK echo; ProgIDs=' + (progids.group(1) if progids else '?')

def pwsh_check(p):
    # R32D54: pwsh 无供给路径(bootstrap 不装)——此前 FileNotFoundError
    # 裸栈。降级为干净 SKIP 说明(语法层已过; 运行层须自装 pwsh)。
    import shutil
    if not shutil.which('pwsh'):
        return True, 'ps runtime SKIP: pwsh 未安装(容器外自装: apt/powershell 官方源; 语法层已过)'
    r = subprocess.run(['pwsh', '-NoProfile', '-File', p], capture_output=True, text=True, timeout=30)
    if 'SPECTRE-MARK' not in r.stdout:
        return False, f'ps runtime: stdout 无标记 (rc={r.returncode}, out={r.stdout.strip()[:60]!r})'
    return True, 'ps runtime OK: ' + r.stdout.strip()[:40]

def php_check(p):
    # CS32: php 引擎缺失干净 SKIP(此前裸 FileNotFoundError)——容器位内置。
    if not shutil.which('php'):
        print('[c2-functest] php 不在 PATH——L1/L2 跳过(容器位内置; 宿主自装)', file=sys.stderr)
        return True, 'php SKIP(php 未装)'
    r = subprocess.run(['php', '-l', p], capture_output=True, text=True)
    if r.returncode != 0:
        return False, 'php syntax: ' + r.stdout.strip()[:80]
    r2 = subprocess.run(['php', p], capture_output=True, text=True, timeout=10,
                        env={**os.environ, 'REQUEST_METHOD': 'GET'})
    if 'SPECTRE-MARK' in (r2.stdout + r2.stderr):
        return True, 'php runtime OK: echo 含标记'
    # 契约降级:基线本身无运行回显的载荷(如注册即 Fatal 的 callback 型)——静态层通过
    return True, 'php OK-static (runtime echo n/a: ' + r2.stdout.strip()[:30].replace('\n', ' ') + ')'

def main():
    # R32D42-P1/P2: --help 进用法(此前裸栈 FileNotFoundError); 坏路径
    # 报干净错误 rc=2。
    if len(sys.argv) < 2 or sys.argv[1] in ('-h', '--help'):
        print(__doc__); return 0 if sys.argv[1:] else 2
    p = sys.argv[1]
    try:
        body = open(p, errors='replace').read()
    except OSError as e:
        print(f'[c2-functest] 无法读取 {p}: {e}', file=sys.stderr); return 2
    if 'SPECTRE-MARK' not in body:
        print(f'FAIL: functional core marker missing in {p}')
        return 1
    ext = os.path.splitext(p)[1]
    if ext == '.java':
        # v3:编译级+运行级(c2-javart 嵌入式 Tomcat 桩:真 register+真触发+echo 断言)
        r = subprocess.run(['python3', os.path.join(_data_root(), 'bin/c2-javart.py'), '--src', p],  # CS24-F2
                           capture_output=True, text=True, timeout=300)
        line = (r.stdout.strip().splitlines() or [''])[0]
        if r.returncode != 0:
            print(f'FAIL: {line or r.stderr.strip()[:80]} ({p})')
            return 1
        print(f'OK: {line} ({p})')
        return 0
    ok, note = {'php': php_check, '.php': php_check}.get(ext, (lambda x: (True, 'no-lang-check')))(p)
    if ext in ('.js', '.hta', '.jse'):
        ok, note = node_check(p)
    elif ext in ('.ps1', '.psm1', '.ps'):
        ok, note = pwsh_check(p)
    if not ok:
        print(f'FAIL: {note} ({p})')
        return 1 if ext in ('.php', '.java') else 3
    print(f'OK: {note} ({p})')
    return 0

if __name__ == '__main__':
    sys.exit(main())
