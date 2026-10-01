#!/usr/bin/env python3
"""c2-bind — 一次性载荷绑定(目标×窗口×指纹,HMAC 防篡改,过期自废)。
用法:
  c2-bind.py bind --payload p [--target benchmark.local] [--days N]
  c2-bind.py verify --payload p [--target t]
  c2-bind.py expire --payload p
规则:
  bind  : 目标必须在 /opt/tools/c2/scope.json targets 内;exp 默认=scope 窗口 end,
          --days N 可提前(不可晚于窗口 end);写入 <payload>.bind.json
          {sha256,target,exercise,exp,sig};sig=HMAC-SHA256(bind.key, sha|target|exercise|exp)
  verify: 载荷被改(sha 不符)=79;目标不在当前 scope=78;过期=77;sig 不符=80;OK=0
  expire: exp 置为过去(立即自废)
"""
import sys, os, json, hmac, hashlib, time, secrets


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
KEYF = os.path.join(_C2, 'bind.key')
AUDIT = os.path.join(_C2, 'audit.log')

def _key():
    if not os.path.exists(KEYF):
        open(KEYF, 'w').write(secrets.token_hex(32))
        os.chmod(KEYF, 0o600)
    return bytes.fromhex(open(KEYF).read().strip())

def _audit(action, note):
    with open(AUDIT, 'a') as f:
        f.write(f'{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}\tBIND\t{action}\t{note}\n')

def sig_of(sha, target, exercise, exp, key=None):
    msg = f'{sha}|{target}|{exercise}|{exp}'.encode()
    return hmac.new(key or _key(), msg, hashlib.sha256).hexdigest()

def side(p):
    return p + '.bind.json'

def cmd_bind(args):
    a = dict(zip(args[::2], args[1::2]))
    p = a['--payload']
    sc = json.load(open(SCOPE))
    target = a.get('--target', sc['targets'][0] if sc.get('targets') else '')
    if target not in sc.get('targets', []):
        print(f'BIND-REJECT: target {target!r} not in scope targets'); return 70
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    if not (sc['window']['start'] <= now <= sc['window']['end']):
        print('BIND-REJECT: out of window'); return 75
    exp = a.get('--days') and time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + int(a['--days']) * 86400)) or sc['window']['end']
    if exp > sc['window']['end']:
        exp = sc['window']['end']
    sha = hashlib.sha256(open(p, 'rb').read()).hexdigest()
    rec = {'sha256': sha, 'target': target, 'exercise': sc['exercise'], 'exp': exp,
           'sig': sig_of(sha, target, sc['exercise'], exp)}
    json.dump(rec, open(side(p), 'w'), indent=1)
    _audit('bind', f'{os.path.basename(p)}\t{sha[:16]}\t{target}\texp={exp}')
    print(f'BOUND {p} → target={target} exp={exp} sha={sha[:16]}')
    return 0

def cmd_verify(args):
    a = dict(zip(args[::2], args[1::2]))
    p = a['--payload']
    if not os.path.exists(side(p)):
        print('VERIFY-FAIL: no binding sidecar'); return 81
    rec = json.load(open(side(p)))
    sc = json.load(open(SCOPE))
    sha = hashlib.sha256(open(p, 'rb').read()).hexdigest()
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    if sha != rec['sha256']:
        print('VERIFY-FAIL: payload changed after bind'); return 79
    if not hmac.compare_digest(rec.get('sig', ''), sig_of(sha, rec['target'], rec['exercise'], rec['exp'])):
        print('VERIFY-FAIL: bad sig'); return 80
    want = a.get('--target', rec['target'])
    if want not in sc.get('targets', []):
        print(f'VERIFY-FAIL: target {want} out of current scope'); return 78
    if now > rec['exp']:
        print(f'EXPIRED: {p} (exp={rec["exp"]}) — 载荷自废,拒绝交付'); return 77
    print(f'VERIFY-OK: {p} target={want} exp={rec["exp"]} (剩余 {rec["exp"][:10]} 前可用)')
    return 0

def cmd_expire(args):
    a = dict(zip(args[::2], args[1::2]))
    p = a['--payload']
    rec = json.load(open(side(p)))
    rec['exp'] = '2000-01-01T00:00:00Z'
    rec['sig'] = sig_of(rec['sha256'], rec['target'], rec['exercise'], rec['exp'])
    json.dump(rec, open(side(p), 'w'), indent=1)
    _audit('expire', os.path.basename(p))
    print(f'EXPIRED (manual): {p}')
    return 0

def main():
    # CS27-9: -h/--help rc=0(与 javart/functest/payload-spec 家族统一)。
    if len(sys.argv) >= 2 and sys.argv[1] in ('-h', '--help'):
        print(__doc__); return 0
    if len(sys.argv) < 2:
        print(__doc__); return 2
    cmd, args = sys.argv[1], sys.argv[2:]
    return {'bind': cmd_bind, 'verify': cmd_verify, 'expire': cmd_expire}.get(cmd, lambda a: (print(__doc__), 2)[1])(args)

if __name__ == '__main__':
    sys.exit(main() or 0)
