#!/usr/bin/env python3
"""c2-basetype — 基型生成适配器(真实生成器接入 + 模板车道)。
用法:
  c2-basetype.py list <serverTypes|shellTypes|formatTypes|toolTypes>
  c2-basetype.py gen --engine jmg --server Tomcat --shell Listener --tool Godzilla \
                     --format BASE64 [--pass x --key k] --name jmg_listener_godzilla \
                     [--out-dir /opt/tools/c2/basetypes-jmg]
  c2-basetype.py verify [--dir /opt/tools/c2/basetypes-jmg]
车道契约(重要):
  source-lane: /opt/tools/c2/basetypes/*.java|php|js|ps1 骨架,含 SPECTRE-MARK 承重标记,
               适用 decomp 文本变换族 + c2-qa/c2-functest 全流水线
  real-lane  : jMG 真实生成 class 字节(BASE64 解码),功能核=内存马本身;标记走
               manifest(sha256/jmg info);文本 decomp 不适用,需字节码变换族(未建,如实)
纪律: 授权门(scope.json)+EDUSRC 隔离+审计,与 c2-qa 同源。
"""

import sys, base64, hashlib, json, os, re, subprocess, time  # CS29/F-B: 恢复全活集(sys 起头族例)-F2 恢复全活集
from _common import scope_gate_full, audit_log, _edusrc_hit, _data_root

_C2 = os.path.join(_data_root(), 'c2')
SCOPE = os.path.join(_C2, 'scope.json')
AUDIT = os.path.join(_C2, 'audit.log')
JMG_JAR = os.path.join(_C2, 'generators/jmg-cli-1.0.9.jar')
DEFAULT_DIR = os.path.join(_C2, 'basetypes-jmg')

def gate():
    # CS37-F2/F3: 收敛 _common 单源门——此前本地副本不查 exercise(SKILL
    # 三必填契约分叉)且坏 JSON 裸栈 rc=1(单源门干净 75)。
    if _edusrc_hit():
        print('EDUSRC-REJECT: 教育 SRC 工作区禁用 C2 载荷能力(工具层硬隔离)'); sys.exit(76)
    return scope_gate_full()


    return sc

def jmg_run(cmds):
    script = '\n'.join(cmds + ['exit']) + '\n'
    r = subprocess.run(['java', '-jar', JMG_JAR], input=script,
                       capture_output=True, text=True, timeout=180)
    return r.stdout

def parse_b64(out):
    best = ''
    for line in out.splitlines():
        s = line.strip()
        if len(s) > len(best) and re.fullmatch(r'[A-Za-z0-9+/=]+', s):
            best = s
    return best or None

def cmd_list(args):
    gate()
    kind = args[0] if args else 'serverTypes'
    print(jmg_run([f'list {kind}']))

def cmd_gen(args):
    sc = gate()
    a = dict(zip(args[::2], args[1::2]))
    outdir = a.get('--out-dir', DEFAULT_DIR)
    os.makedirs(outdir, exist_ok=True)
    name = a.get('--name') or f"jmg_{a.get('--shell','x').lower()}_{a.get('--server','x').lower()}"
    cmds = [
        f"use serverType {a.get('--server', 'Tomcat')}",
        f"use shellType {a.get('--shell', 'Listener')}",
        f"use toolType {a.get('--tool', 'Godzilla')}",
        f"use formatType {a.get('--format', 'BASE64')}",
    ]
    if a.get('--pass'):
        cmds.append(f"set pass {a['--pass']}")
    if a.get('--key'):
        cmds.append(f"set key {a['--key']}")
    info = jmg_run(cmds + ['info'])
    out = jmg_run(cmds + ['generate'])
    b64 = parse_b64(out)
    if not b64:
        print('GEN-FAIL: no base64 payload in jmg output'); return 1
    try:
        raw = base64.b64decode(b64, validate=True)
        assert raw[:4] == b'\xca\xfe\xba\xbe', 'not a class file magic'
    except Exception as e:
        print(f'GEN-FAIL: {e}'); return 1
    cp = os.path.join(outdir, name + '.class')
    open(cp, 'wb').write(raw)
    open(cp + '.b64', 'w').write(b64)
    sha = hashlib.sha256(raw).hexdigest()
    mf_path = os.path.join(outdir, 'manifest.json')
    mf = json.load(open(mf_path)) if os.path.exists(mf_path) else []
    mf.append({'name': name, 'file': cp, 'sha256': sha, 'engine': 'jMG-1.0.9',
               'server': a.get('--server', 'Tomcat'), 'shell': a.get('--shell', 'Listener'),
               'tool': a.get('--tool', 'Godzilla'), 'format': a.get('--format', 'BASE64'),
               'lane': 'real-lane(class-bytes)', 'info': info.strip().splitlines()[-3:]})
    json.dump(mf, open(mf_path, 'w'), indent=1)
    audit_log(AUDIT, 'BASETYPE', 'gen', sha[:16], f'{name} real-lane')
    print(f'GEN-OK: {cp} ({len(raw)} bytes, sha={sha[:16]}) → manifest 注册,车道=real-lane(class-bytes)')
    print('注意: real-lane 不适用文本 decomp;QA 需字节码变换族(未建)。')
    return 0

def cmd_verify(args):
    a = dict(zip(args[::2], args[1::2])) if args else {}
    d = a.get('--dir', DEFAULT_DIR)
    mf_path = os.path.join(d, 'manifest.json')
    if not os.path.exists(mf_path):
        print('no manifest'); return 1
    bad = 0
    for e in json.load(open(mf_path)):
        sha = hashlib.sha256(open(e['file'], 'rb').read()).hexdigest()
        ok = sha == e['sha256']
        bad += 0 if ok else 1
        print(f"{'OK ' if ok else 'BAD'} {e['name']} {e['sha256'][:12]} lane={e['lane']}")
    return 1 if bad else 0

def main():
    # CS27-9: -h/--help rc=0(与 javart/functest/payload-spec 家族统一)。
    if len(sys.argv) >= 2 and sys.argv[1] in ('-h', '--help'):
        print(__doc__); return 0
    if len(sys.argv) < 2:
        print(__doc__); return 2
    cmd, args = sys.argv[1], sys.argv[2:]
    return {'list': cmd_list, 'gen': cmd_gen, 'verify': cmd_verify}.get(
        cmd, lambda a: (print(__doc__), 2)[1])(args)

if __name__ == '__main__':
    sys.exit(main() or 0)
