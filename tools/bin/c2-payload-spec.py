#!/usr/bin/env python3
"""c2-payload-spec — Mythic 式载荷类型插件(P2 借鉴)
把「协议→注入位→变换家族→验证」声明为 JSON spec——新协议支持=写一个 spec 文件。
spec 结构:
{
  "name": "http-webshell",
  "language": "php",
  "protocol": {"transport": "http", "beacon_interval": [30, 120], "jitter": 0.3},
  "injection_points": [{"type": "query", "key": "c", "encoding": "raw|b64|hex"}],
  "transform_families": ["mask", "decomp", "id", "struct"],
  "validation": {"syntax_check": "php -l", "edusrc_block": true},
  "base_type": "php-webshell-generic"
}
用法:
  c2-payload-spec list
  c2-payload-spec validate --spec http-webshell.json
  c2-payload-spec gen --spec http-webshell.json --src payload.php --out /tmp/out --rounds 3
"""
import sys, os, json, subprocess, argparse
from pathlib import Path

SPEC_DIR = '/opt/tools/c2/payload-specs'
ENGINE = '/opt/tools/bin/c2-variant.py'

REQUIRED = ['name', 'language', 'protocol', 'injection_points', 'transform_families']
KNOWN_FAMILIES = ['mask', 'decomp', 'id', 'enc', 'code', 'struct']
KNOWN_LANGS = ['php', 'java', 'js', 'ps', 'aspx', 'jsp']

def load_spec(path):
    spec = json.load(open(path))
    errors = []
    for k in REQUIRED:
        if k not in spec:
            errors.append(f'缺必填字段: {k}')
    if 'transform_families' in spec:
        bad = [f for f in spec['transform_families'] if f not in KNOWN_FAMILIES]
        if bad:
            errors.append(f'未知变换族: {bad}(合法: {KNOWN_FAMILIES})')
    if 'language' in spec and spec['language'] not in KNOWN_LANGS:
        errors.append(f'未知语言: {spec["language"]}(合法: {KNOWN_LANGS})')
    if 'injection_points' in spec:
        for ip in spec['injection_points']:
            if ip.get('type') not in ('query', 'header', 'body', 'cookie', 'path'):
                errors.append(f'非法注入位类型: {ip.get("type")}')
            if ip.get('encoding') not in ('raw', 'b64', 'hex', 'url'):
                errors.append(f'非法编码: {ip.get("encoding")}')
    return spec, errors

def list_specs():
    out = []
    if not os.path.isdir(SPEC_DIR):
        return out
    for fn in sorted(os.listdir(SPEC_DIR)):
        if fn.endswith('.json'):
            try:
                spec, errs = load_spec(os.path.join(SPEC_DIR, fn))
                out.append({'file': fn, 'name': spec.get('name', '?'),
                            'lang': spec.get('language', '?'),
                            'families': spec.get('transform_families', []),
                            'valid': len(errs) == 0, 'errors': errs[:2]})
            except Exception as e:
                out.append({'file': fn, 'name': '?', 'valid': False, 'errors': [str(e)[:60]]})
    return out

def gen(spec, src, out_dir, rounds):
    """调用 c2-variant 引擎——按 spec 限定家族"""
    families = ','.join(spec['transform_families'])
    cmd = ['python3', ENGINE, 'gen', '--src', src, '--out', out_dir,
           '--rounds', str(rounds), '--families', families]
    v = spec.get('validation', {})
    if v.get('edusrc_block', True):
        pass  # c2-variant 内置 EDUSRC 门
    r = subprocess.run(cmd, capture_output=True, text=True)
    # BUG-2: 只回显尾 500 字符砍头,下游 json.loads 必炸——读磁盘 manifest 全文
    import os as _os
    mani = _os.path.join(out, 'manifest.json')
    full = open(mani).read() if _os.path.exists(mani) else r.stdout[-500:]
    return r.returncode, full, r.stderr[-200:]

BUILTIN = {
    'http-webshell': {
        'name': 'http-webshell', 'language': 'php',
        'protocol': {'transport': 'http', 'beacon_interval': [30, 120], 'jitter': 0.3},
        'injection_points': [{'type': 'query', 'key': 'c', 'encoding': 'raw'},
                             {'type': 'cookie', 'key': 'sess', 'encoding': 'b64'}],
        'transform_families': ['mask', 'decomp', 'id', 'struct'],
        'validation': {'syntax_check': 'php -l', 'edusrc_block': True},
    },
    'http-jsp': {
        'name': 'http-jsp', 'language': 'java',
        'protocol': {'transport': 'http', 'beacon_interval': [60, 300], 'jitter': 0.2},
        'injection_points': [{'type': 'header', 'key': 'X-Trace-Id', 'encoding': 'b64'},
                             {'type': 'body', 'key': 'log', 'encoding': 'url'}],
        'transform_families': ['mask', 'decomp', 'id', 'struct'],
        'validation': {'edusrc_block': True},
    },
    'http-ps': {
        'name': 'http-ps', 'language': 'ps',
        'protocol': {'transport': 'http', 'beacon_interval': [45, 180], 'jitter': 0.25},
        'injection_points': [{'type': 'header', 'key': 'Authorization', 'encoding': 'b64'}],
        'transform_families': ['mask', 'decomp', 'id'],
        'validation': {'edusrc_block': True},
    },
}

def init_builtin():
    os.makedirs(SPEC_DIR, exist_ok=True)
    for name, spec in BUILTIN.items():
        p = os.path.join(SPEC_DIR, f'{name}.json')
        if not os.path.exists(p):
            json.dump(spec, open(p, 'w'), indent=1)
            print(f'  + {p}')
        else:
            print(f'  = {p} (exists)')

if __name__ == '__main__':
    # BUG-3: --help/拼错子命令零输出 RC=0——与姊妹工具一致兜底
    if len(sys.argv) < 2 or sys.argv[1] in ('-h', '--help') or sys.argv[1] not in ('list', 'validate', 'gen', 'init'):
        print(__doc__); sys.exit(2 if len(sys.argv) >= 2 else 0)
    mode = sys.argv[1]
    if mode == 'list':
        for s in list_specs():
            mark = '✓' if s['valid'] else '✗'
            print(f"{mark} {s['name']:>18} [{s.get('lang','?'):>5}] families={','.join(s.get('families',[]))}")
            for e in s.get('errors', []):
                print(f"    ✗ {e}")
    elif mode == 'validate':
        spec_path = sys.argv[sys.argv.index('--spec') + 1] if '--spec' in sys.argv else None
        if not spec_path:
            print('validate 需要 --spec'); sys.exit(1)
        spec, errs = load_spec(spec_path)
        if errs:
            print('✗ ' + '; '.join(errs)); sys.exit(1)
        print(f"✓ {spec['name']} 合法({len(spec['injection_points'])} 注入位,{len(spec['transform_families'])} 变换族)")
    elif mode == 'gen':
        spec_path = sys.argv[sys.argv.index('--spec') + 1] if '--spec' in sys.argv else None
        src = sys.argv[sys.argv.index('--src') + 1] if '--src' in sys.argv else None
        out = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else '/tmp/out'
        rounds = int(sys.argv[sys.argv.index('--rounds') + 1]) if '--rounds' in sys.argv else 3
        if not spec_path or not src:
            print('gen 需要 --spec --src'); sys.exit(1)
        spec, errs = load_spec(spec_path)
        if errs:
            print('spec 非法: ' + '; '.join(errs)); sys.exit(1)
        rc, so, se = gen(spec, src, out, rounds)
        print(so)
        if se:
            print(se, file=sys.stderr)
        sys.exit(rc)
    elif mode == 'init':
        init_builtin()
