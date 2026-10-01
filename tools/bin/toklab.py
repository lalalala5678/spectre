#!/usr/bin/env python3
"""toklab — 令牌工位:decode/forge/brute 三位一体。
用法:
  toklab decode <token>                          # 拆 body.sig,展示结构与哈希指纹
  toklab forge --scheme md5prefix --secret S --body '{"u":"admin"}' [--trunc 16]
  toklab brute --pairs captured.txt --wordlist w.txt [--scheme md5prefix|md5suffix|hmac_md5|hmac_sha256|sha256prefix] [--trunc 16]
  toklab brute --pairs p.txt --base school,campus,edu --rules year_suffix      # 语义生成(基词×年份×大小写,免手搓字典)
captured.txt 每行: <body>\\t<sig>  (离线爆破,零在线请求)
"""
import base64, hashlib, hmac, sys  # CS29-F3 恢复全活集

def b64d(s):
    s2 = s + '=' * (-len(s) % 4)
    for dec in (base64.urlsafe_b64decode, base64.b64decode):
        try:
            return dec(s2)
        except Exception:
            continue
    return b''

SCHEMES = {
    'md5prefix':  lambda s, b: hashlib.md5((s + b).encode()).hexdigest(),
    'md5suffix':  lambda s, b: hashlib.md5((b + s).encode()).hexdigest(),
    'sha1prefix': lambda s, b: hashlib.sha1((s + b).encode()).hexdigest(),
    'sha256prefix': lambda s, b: hashlib.sha256((s + b).encode()).hexdigest(),
    'hmac_md5':   lambda s, b: hmac.new(s.encode(), b.encode(), hashlib.md5).hexdigest(),
    'hmac_sha1':  lambda s, b: hmac.new(s.encode(), b.encode(), hashlib.sha1).hexdigest(),
    'hmac_sha256': lambda s, b: hmac.new(s.encode(), b.encode(), hashlib.sha256).hexdigest(),
}

def gen_year_suffix(bases):
    """基词 × 2010-2026 年份 × 大小写全形态(三轮 63k 发教训的生成器落地)。"""
    out = []
    for b in bases:
        for form in (b, b.capitalize(), b.upper()):
            out.append(form)
            for y in range(2010, 2027):
                out.append(f'{form}{y}')
                out.append(f'{form}@{y}')
                out.append(f'{form}#{y}')
                out.append(f'{form}-{y}')
    return out

def cmd_decode(tok):
    parts = tok.split('.')
    print(f"段数: {len(parts)}")
    for i, p in enumerate(parts):
        is_last = (i == len(parts) - 1)
        looks_b64 = any(c in p for c in '+/-_=') or (not is_last)
        raw = b64d(p) if looks_b64 and not is_last else b''
        if raw:
            try:
                print(f"  [{i}] {p[:40]}... → {raw.decode(errors='replace')[:200]}")
            except Exception:
                print(f"  [{i}] {p[:40]}... (binary {len(raw)}B)")
        else:
            print(f"  [{i}] {p[:60]}")
    sig = parts[-1]
    n = len(sig)
    fp = 'md5' if n == 32 else 'sha1' if n == 40 else 'sha256' if n == 64 else f'len={n}(截断?)'
    print(f'sig 长度: {n} → {fp}')
    if n in (16, 20, 48):
        print("  ↳ 截断指纹(标准 hex 32/40/64 的一半)——brute 时 --trunc 匹配此长度")
    return 0

def cmd_forge(args):
    a = dict(zip(args[::2], args[1::2]))
    scheme, secret, body = a.get('--scheme', 'md5prefix'), a.get('--secret', ''), a.get('--body', '{}')
    trunc = int(a.get('--trunc', 0)) or None
    enc = base64.urlsafe_b64encode(body.encode()).decode().rstrip('=')
    h = SCHEMES[scheme](secret, enc)  # 签名对象=实际发送的段(b64 串),非原文
    if trunc:
        h = h[:trunc]
    print(f"{enc}.{h}")
    return 0

def cmd_brute(args):
    a = dict(zip(args[::2], args[1::2]))
    pairs = []
    for line in open(a['--pairs']):
        if '\t' in line:
            b, s = line.rstrip('\n').split('\t', 1)
            pairs.append((b, s))
    if '--base' in a and '--rules' in a:
        words = gen_year_suffix([w.strip() for w in a['--base'].split(',') if w.strip()])
    else:
        words = [w.strip() for w in open(a['--wordlist']) if w.strip()]
    trunc = int(a.get('--trunc', 0)) or None
    schemes = a.get('--scheme', 'md5prefix').split(',')
    tried = 0
    for scheme in schemes:
        fn = SCHEMES[scheme]
        for w in words:
            ok = True
            for body, sig in pairs:
                h = fn(w, body)
                if trunc:
                    h = h[:trunc]
                if h != sig:
                    ok = False
                    break
            tried += 1
            if ok:
                print(f"[+] HIT scheme={scheme} secret={w!r} ({tried} tries)")
                return 0
    print(f"[-] miss ({tried} tries × {len(schemes)} schemes)")
    return 1

def main():
    # R32D53: -h rc=0(家族统一)。
    if len(sys.argv) >= 2 and sys.argv[1] in ('-h', '--help'):
        print(__doc__)
        return 0
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == 'decode':
        return cmd_decode(args[0])
    if cmd == 'forge':
        return cmd_forge(args)
    if cmd == 'brute':
        return cmd_brute(args)
    print(__doc__)
    return 2

if __name__ == '__main__':
    sys.exit(main() or 0)
