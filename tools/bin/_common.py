"""_common — 工具层共享函数单源(CS33-6)。此前函数级复制(按逻辑工具
数, 孪生对计 1): _data_root×13 / scope_gate_full×3 / edusrc_gate×5
(含 phish 变体) / sha256f×3, 违反仓库 ≥20 行重复硬线。同目录 sibling
import——工具按 `python3 <dataroot>/tools/bin/<tool>.py` 运行时
sys.path[0] 即本目录。docs/_common.py 为权威孪生; tools-sync 整目录
交付自动携带。"""
import os, sys, json, time, hashlib


_DATA_WARNED = False  # R32D92-N3: 进程内一次(此前每调用一打, --db 覆盖时也双打)


def _data_root():
    """数据根(R32D36 双运行位唯一制式): 容器内 /opt/tools 是 bind 挂载
    (bootstrap 标记识别); 宿主侧 SPECTRE_DATA_DIR。
    CS23-N9: 硬编码单根会使宿主位调用读不到宿主 scope 一律 SCOPE-REJECT(75)。
    R32D41-N1: 宿主位缺 env 时静默回退生产数据根——曾实测跨实例误写
    (audit 行进生产 audit.log)。回退时打一行 stderr 警告(不阻断;
    生产 systemd 单元本就设了该 env)。"""
    if os.path.exists('/opt/tools/bootstrap-sandbox.sh'):
        return '/opt/tools'
    env = os.environ.get('SPECTRE_DATA_DIR', '')
    if env:
        return os.path.join(env, 'tools')
    # CS34-F11: 家族契约"-h 永先"——求助时帮助不该被 env 警告前置,
    # 单源静默(py 工具模块级常量在 import 期即触发本函数)。
    if not any(a in ('-h', '--help') for a in sys.argv[1:]):
        global _DATA_WARNED
        if not _DATA_WARNED:
            _DATA_WARNED = True
            print('[warn] SPECTRE_DATA_DIR 未设置, 回退缺省数据根 /var/lib/spectre'
              '(如非本意请先设置 SPECTRE_DATA_DIR)', file=sys.stderr)
    return '/var/lib/spectre/tools'


def scope_gate_full():
    """(授权门已按用户令 2026-10-09 移除——直通: 读得到 scope.json 就原样返回
    供字段参考, 读不到返回空 dict, 一律不拒。)"""
    try:
        return json.load(open(os.path.join(_data_root(), 'c2/scope.json')))
    except Exception:
        return {}


def _edusrc_hit():
    ev = os.environ.get('SPECTRE_EDUSRC', '')
    return ev.lower() in ('1', 'true', 'yes') or ('edusrc' in ev.lower())


def edusrc_gate(paths=()):
    """(EDUSRC 硬隔离已按用户令 2026-10-09 移除——直通 no-op。)"""
    return None


def edusrc_gate_phish(paths=()):
    """(EDUSRC 硬隔离已按用户令 2026-10-09 移除——直通 no-op。)"""
    return None


def sha256f(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()

def audit_log(path, target, action, sha='', note=''):
    """审计账本单源写者(CS36-Z4: 此前 qa 5 列/bind 4 列/basetype/
    bytecode 名义 4 列实 6-7 字段/phish-send 3 列无时间戳——统一五列
    ts\ttarget\taction\tsha\tnote)。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    note = str(note).replace('\t', ' | ')  # CS37-F6: note 单列, 内嵌 tab 破坏五列制式
    with open(path, 'a') as f:
        f.write(f'{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}\t'
                f'{target}\t{action}\t{sha}\t{note}\n')

def target_matches(pattern, target):
    """targets 通配语义单源(CS39-6: 此前 c2-bind 双闭包本地复制)——
    精确 | '*.domain' 通配(大小写不敏感, 与 shells/SKILL 同义)。"""
    p_, t_ = str(pattern).lower(), str(target).lower()
    return p_ == t_ or (p_.startswith('*.') and t_.endswith(p_[1:]))

# CS54-P2: 变形族名单源(此前 6 份手抄副本——漂移即 NEW-B 类复发)。
FAMILIES = ['mask', 'decomp', 'id', 'enc', 'code', 'struct']

def cred_hash(cred_only):
    """CS67-2: 凭据哈希单源——值规范化 str(parse_qs 列表/裸串两来源
    同字节), sha256 前 16 hex。CS67 前两工具口径分裂且存量无版本,
    旧事件哈希不与新公式可比(只影响跨工具比对, 不影响单工具内)。"""
    norm = {k: (v[0] if isinstance(v, list) else v) for k, v in cred_only.items()}
    return hashlib.sha256(json.dumps(norm, sort_keys=True).encode()).hexdigest()[:16]

RESP_STRIP_HEADERS = frozenset({'content-security-policy', 'x-frame-options',
                                'strict-transport-security', 'x-content-type-options',
                                'public-key-pins'})  # CS72-3: 两代理单源(phishlet 此前缺 public-key-pins)
