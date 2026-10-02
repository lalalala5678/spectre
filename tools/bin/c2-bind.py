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
  门序: 三子命令一致 scope 先于用法(bind 无 EDUSRC 门——目标绑定语义另行, 见 SKILL)。
  verify: OK=0;载荷被改(sha 不符)=79;目标不在当前 scope=78;过期=77;sig 不符=80;
         无/坏 sidecar=81;scope 缺/坏=75;缺参=2
  expire: exp 置为过去(立即自废)
"""
import sys, os, json, hmac, hashlib, time, secrets
from _common import scope_gate_full, target_matches, audit_log, _data_root


_C2 = os.path.join(_data_root(), 'c2')
KEYF = os.path.join(_C2, 'bind.key')
AUDIT = os.path.join(_C2, 'audit.log')

def _key():
    if not os.path.exists(KEYF):
        open(KEYF, 'w').write(secrets.token_hex(32))
        os.chmod(KEYF, 0o600)
    return bytes.fromhex(open(KEYF).read().strip())

def sig_of(sha, target, exercise, exp, key=None):
    msg = f'{sha}|{target}|{exercise}|{exp}'.encode()
    return hmac.new(key or _key(), msg, hashlib.sha256).hexdigest()

def side(p):
    return p + '.bind.json'

def cmd_bind(args):
    a = dict(zip(args[::2], args[1::2]))
    # CS42-F5: 门序契约全对齐——scope 门先于一切用法(此前缺参 rc=2 在
    # 门前、文件 rc=2 在门后; bind 无 EDUSRC 门, 见 SKILL)。
    sc = scope_gate_full()
    if '--payload' not in a:
        print('用法: c2-bind.py bind --payload <file> [--target t] [--days N]', file=sys.stderr)
        return 2
    p = a['--payload']
    # R32D60-NEW4: payload 不存在/是目录→干净 rc=2(此前裸栈 rc=1)。
    if not os.path.isfile(p):
        print(f'用法错误: --payload 文件不存在或不是常规文件: {p}', file=sys.stderr); return 2
    if a.get('--days') and not a['--days'].lstrip('-').isdigit():
        print('用法: --days 须为整数天数', file=sys.stderr); return 2
    target = a.get('--target', sc['targets'][0] if sc.get('targets') else '')
    # CS30-F8/CS39-6: targets 通配语义单源(_common.target_matches)。
    if not any(target_matches(t, target) for t in sc.get('targets', [])):
        print(f'BIND-REJECT: target {target!r} not in scope targets', file=sys.stderr); return 70
    # CS40-8: 出窗复查删——scope_gate_full 已同窗断言(此处仅秒界竞态
    # 可达, 消息与门分叉)。
    exp = a.get('--days') and time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + int(a['--days']) * 86400)) or sc['window']['end']
    if exp > sc['window']['end']:
        exp = sc['window']['end']
    sha = hashlib.sha256(open(p, 'rb').read()).hexdigest()
    rec = {'sha256': sha, 'target': target, 'exercise': sc['exercise'], 'exp': exp,
           'sig': sig_of(sha, target, sc['exercise'], exp)}
    json.dump(rec, open(side(p), 'w'), ensure_ascii=False, indent=1)
    audit_log(AUDIT, 'BIND', 'bind', sha[:16], f'{os.path.basename(p)} | {target} | exp={exp}')
    print(f'BOUND {p} → target={target} exp={exp} sha={sha[:16]}')
    return 0

def cmd_verify(args):
    a = dict(zip(args[::2], args[1::2]))
    # R32D64-P3: 门序同 bind 子命令(scope 先于用法——此前同文件两种
    # 顺序直觉分裂)。
    sc = scope_gate_full()
    # CS37-F4: 缺参干净 usage rc=2(此前 KeyError 裸栈)。
    if '--payload' not in a:
        print('用法: c2-bind.py verify --payload <file> [--target t]', file=sys.stderr); return 2
    p = a['--payload']
    if not os.path.isfile(p):
        print(f'用法错误: --payload 文件不存在或不是常规文件: {p}', file=sys.stderr); return 2
    if not os.path.exists(side(p)):
        print('VERIFY-FAIL: no binding sidecar', file=sys.stderr); return 81
    # CS38-G3: sidecar/scope 读面守卫(此前坏 JSON/缺 scope 裸栈 rc=1)。
    try:
        rec = json.load(open(side(p)))
    except Exception as e:
        print(f'VERIFY-FAIL: bad sidecar json: {e}', file=sys.stderr); return 81
    # CS39-2: 结构坏 sidecar(合法 JSON 缺键)与解析坏同拒——此前 rec['sha256']
    # 等 KeyError 裸栈, 同函数 rec.get('sig','') 却防御(自相矛盾)。
    if not all(k in rec for k in ('sha256', 'target', 'exercise', 'exp')):
        print('VERIFY-FAIL: bad sidecar shape(缺 sha256/target/exercise/exp)', file=sys.stderr); return 81
    sha = hashlib.sha256(open(p, 'rb').read()).hexdigest()
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    if sha != rec['sha256']:
        print('VERIFY-FAIL: payload changed after bind', file=sys.stderr); return 79
    if not hmac.compare_digest(rec.get('sig', ''), sig_of(sha, rec['target'], rec['exercise'], rec['exp'])):
        print('VERIFY-FAIL: bad sig', file=sys.stderr); return 80
    want = a.get('--target', rec['target'])
    # CS38-G2/CS39-6: 通配语义单源(_common.target_matches)。
    if not any(target_matches(t, want) for t in sc.get('targets', [])):
        print(f'VERIFY-FAIL: target {want} out of current scope', file=sys.stderr); return 78
    if now > rec['exp']:
        print(f'EXPIRED: {p} (exp={rec["exp"]}) — 载荷自废,拒绝交付', file=sys.stderr); return 77
    print(f'VERIFY-OK: {p} target={want} exp={rec["exp"]} (剩余 {rec["exp"][:10]} 前可用)')
    return 0

def cmd_expire(args):
    a = dict(zip(args[::2], args[1::2]))
    # R32D64-P3: 门序同 bind/verify(scope 先于用法)。
    scope_gate_full()
    # CS37-F4: 缺参干净 usage rc=2。
    if '--payload' not in a:
        print('用法: c2-bind.py expire --payload <file>', file=sys.stderr); return 2
    p = a['--payload']
    if not os.path.isfile(p):
        print(f'用法错误: --payload 文件不存在或不是常规文件: {p}', file=sys.stderr); return 2
    if not os.path.exists(side(p)):
        print('EXPIRE-FAIL: no binding sidecar', file=sys.stderr); return 81
    try:
        rec = json.load(open(side(p)))
    except Exception as e:
        print(f'EXPIRE-FAIL: bad sidecar json: {e}', file=sys.stderr); return 81
    if not all(k in rec for k in ('sha256', 'target', 'exercise', 'exp')):
        print('EXPIRE-FAIL: bad sidecar shape(缺 sha256/target/exercise/exp)', file=sys.stderr); return 81
    rec['exp'] = '2000-01-01T00:00:00Z'
    rec['sig'] = sig_of(rec['sha256'], rec['target'], rec['exercise'], rec['exp'])
    json.dump(rec, open(side(p), 'w'), ensure_ascii=False, indent=1)
    audit_log(AUDIT, 'BIND', 'expire', '', os.path.basename(p))
    print(f'EXPIRED (manual): {p}')
    return 0

def main():
    # CS27-9: -h/--help rc=0(与 javart/functest/payload-spec 家族统一)。
    if any(x in sys.argv[1:] for x in ('-h', '--help')):  # R32D76-N3: 任意位(对齐 phish 族)
        print(__doc__); return 0
    if len(sys.argv) < 2:
        print(__doc__); return 2
    cmd, args = sys.argv[1], sys.argv[2:]
    return {'bind': cmd_bind, 'verify': cmd_verify, 'expire': cmd_expire}.get(cmd, lambda a: (print(__doc__), 2)[1])(args)

if __name__ == '__main__':
    sys.exit(main() or 0)
