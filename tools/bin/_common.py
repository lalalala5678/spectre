"""_common — 工具层共享函数单源(CS33-6)。此前函数级复制(按逻辑工具
数, 孪生对计 1): _data_root×13 / scope_gate_full×3 / edusrc_gate×5
(含 phish 变体) / sha256f×3, 违反仓库 ≥20 行重复硬线。同目录 sibling
import——工具按 `python3 <dataroot>/tools/bin/<tool>.py` 运行时
sys.path[0] 即本目录。docs/_common.py 为权威孪生; tools-sync 整目录
交付自动携带。"""
import os, sys, json, time, hashlib


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
        print('[warn] SPECTRE_DATA_DIR 未设置, 回退缺省数据根 /var/lib/spectre'
              '(如非本意请先设置 SPECTRE_DATA_DIR)', file=sys.stderr)
    return '/var/lib/spectre/tools'


def scope_gate_full():
    """完整授权门: targets+exercise+window 三必填(SKILL 契约), exit 75。"""
    SCOPE = os.path.join(_data_root(), 'c2/scope.json')
    # R32D65-N3: 解析错/校验错分报(此前 JSON 异常折叠进'empty targets'
    # 误导排障——与 qa 内联门的真因消息分叉)。
    try:
        sc = json.load(open(SCOPE))
    except FileNotFoundError:
        print(f'SCOPE-REJECT: no scope file(期望 {SCOPE})', file=sys.stderr); sys.exit(75)
    except Exception as e:
        print(f'SCOPE-REJECT: bad scope.json: {e}', file=sys.stderr); sys.exit(75)
    try:
        now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        # CS36-Z3: SKILL 三必填契约(targets/exercise/window)——exercise
        # 此前仅 c2-qa 查, 单源门补齐族内一致。
        ok = (sc.get('targets') and sc.get('exercise') and
              sc['window']['start'] and sc['window']['end'] and
              sc['window']['start'] <= now <= sc['window']['end'])
    except Exception:
        ok = False
    if not ok:
        print('SCOPE-REJECT: empty targets/exercise or out of window', file=sys.stderr)
        sys.exit(75)
    return sc


def _edusrc_hit():
    ev = os.environ.get('SPECTRE_EDUSRC', '')
    return ev.lower() in ('1', 'true', 'yes') or ('edusrc' in ev.lower())


def edusrc_gate(paths=()):
    """F48: EDU SRC 硬隔离——仅显式 env 旗标触发(exit 76)。
    R32D58 用户裁定: 此前的 cwd/路径启发式会误伤正常使用(目录名碰巧
    含 edusrc 即拒), 一律废除——不影响任何未显式声明的工作区。paths
    形参保留以稳调用面, 不再参与判定。"""
    if _edusrc_hit():
        print('EDUSRC-REJECT: 教育 SRC 工作区禁用 C2 载荷能力(工具层硬隔离)', file=sys.stderr)
        sys.exit(76)


def edusrc_gate_phish(paths=()):
    """F48: EDUSRC 硬隔离(同 c2-qa 语义)——仅显式 env 旗标触发(exit 76;
    R32D58 同上裁定, 路径启发式废除)。"""
    if _edusrc_hit():
        print('EDUSRC-REJECT: 教育 SRC 工作区禁用钓鱼能力(工具层硬隔离)', file=sys.stderr)
        sys.exit(76)


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
