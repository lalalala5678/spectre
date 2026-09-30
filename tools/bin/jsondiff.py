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
    a, b = load(sys.argv[1]), load(sys.argv[2])
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
