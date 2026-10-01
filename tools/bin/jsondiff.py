#!/usr/bin/env python3
"""jsondiff — 响应差分器:两个 JSON 文件/字符串的字段级 +/- 表。
用法: jsondiff resp_a.json resp_b.json   (或 echo '{"a":1}' | jsondiff - resp_b.json)
输出: 字段路径 | A | B | 变化类型 — PPOR/隐藏字段判定的直接证据。
"""
import sys, json

def load(p):
    if p == '-':
        return json.load(sys.stdin)
    return json.load(open(p))

def flat(o, prefix=''):
    out = {}
    if isinstance(o, dict):
        for k, v in o.items():
            out.update(flat(v, f'{prefix}.{k}' if prefix else k))
    elif isinstance(o, list):
        for i, v in enumerate(o[:5]):
            out.update(flat(v, f'{prefix}[{i}]'))
    else:
        out[prefix] = o
    return out

def main():
    # R32D42-P1/P2: --help/参数不足/坏 JSON 均不再裸栈。
    if len(sys.argv) < 3 or any(x in ('-h', '--help') for x in sys.argv[1:3]):
        print(__doc__); return 0 if '--help' in sys.argv or '-h' in sys.argv else 2
    try:
        a, b = load(sys.argv[1]), load(sys.argv[2])
    except (OSError, ValueError) as e:
        print(f'[jsondiff] 读取失败: {e}', file=sys.stderr); return 2
    fa, fb = flat(a), flat(b)
    rows = 0
    for k in sorted(set(fa) | set(fb)):
        va, vb = fa.get(k, '‹absent›'), fb.get(k, '‹absent›')
        if va != vb:
            kind = 'A-only' if vb == '‹absent›' else 'B-only' if va == '‹absent›' else 'diff'
            print(f'{kind:8} {k:44} {str(va)[:36]:38} → {str(vb)[:36]}')
            rows += 1
    print(f'--- {rows} 差异行 / {len(fa)} vs {len(fb)} 字段')
    return 0

if __name__ == '__main__':
    sys.exit(main())
