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
    """完整授权门: targets+window 双校验, exit 75。与 c2-qa.gate 的
    差异: 后者另强制 sc.exercise 必填(CS8-P2-2)——勿再写'同 c2-qa'。"""
    SCOPE = os.path.join(_data_root(), 'c2/scope.json')
    if not os.path.exists(SCOPE):
        print('SCOPE-REJECT: no scope file', file=sys.stderr); sys.exit(75)
    try:
        sc = json.load(open(SCOPE))
        now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        ok = (sc.get('targets') and
              sc['window']['start'] and sc['window']['end'] and
              sc['window']['start'] <= now <= sc['window']['end'])
    except Exception:
        ok = False
    if not ok:
        print('SCOPE-REJECT: empty targets or out of window', file=sys.stderr)
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
        print('EDUSRC-REJECT: 教育 SRC 工作区禁用 C2 载荷能力(工具层硬隔离)')
        sys.exit(76)


def edusrc_gate_phish(paths=()):
    """F48: EDUSRC 硬隔离(同 c2-qa 语义)——仅显式 env 旗标触发(exit 76;
    R32D58 同上裁定, 路径启发式废除)。"""
    if _edusrc_hit():
        print('EDUSRC-REJECT: 教育 SRC 工作区禁用钓鱼能力(工具层硬隔离)', file=sys.stderr)
        sys.exit(76)


def sha256f(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()
