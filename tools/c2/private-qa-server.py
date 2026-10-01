#!/usr/bin/env python3
"""private-qa-server — 真私架面杀端点(部署级, 替换 mock)。

契约(与 c2-qa.py eng_private 对端, 零改动):
  POST /scan  multipart 字段 sample;鉴权头 X-SPECTRE-Token
  响应 {"detected":bool,"signature":"sig1,sig2","engine":"PrivateRack(clamav+yara)"}
  GET /health → {"ok":true,"engines":[...]}

真引擎矩阵(容器内, 经 docker exec 调用, 病毒库在持久挂载):
  - clamscan(ClamAV, 3.28M 签名, /opt/tools/c2/clamav-db)
  - yara × 全规则集(/opt/tools/c2/yara-rules/*.yar|*.yara)
样本经共享挂载传递, 不出宿主。扩展引擎=在 ENGINES 加一条命令模板。

配置: /opt/tools/c2/private-qa.json {"url":"http://127.0.0.1:8899/scan","token":"..."}
(c2-qa.py 文件优先读它, env PRIVATE_QA_URL/TOKEN 兜底。)
"""

from http.server import BaseHTTPRequestHandler
import sys, glob, json, os, secrets, subprocess  # CS29/F-B: 恢复全活集(sys 起头族例)-F1 恢复(误删的活 import)

CONTAINER = os.environ.get('SPECTRE_SANDBOX_CONTAINER', '')
# CS8-P1-3: 数据根走 SPECTRE_DATA_DIR(镜像 deploy/oob-collector.py 先例)
# ——该服务以 $SPECTRE_DATA_DIR 部署启动, 此前硬编码使隔离实例读生产。
# R32D41-N1: 缺 env 静默回退生产数据根即警(与 py 工具守卫同制式)。
_ROOT = os.environ.get('SPECTRE_DATA_DIR', '')
if not _ROOT:
    print('[warn] SPECTRE_DATA_DIR 未设置, 回退缺省数据根 /var/lib/spectre'
          '(如非本意请先设置 SPECTRE_DATA_DIR)', file=sys.stderr)
    _ROOT = '/var/lib/spectre'
_TOOLS = os.path.join(_ROOT, 'tools')
INBOX = os.path.join(_TOOLS, 'c2/qa-inbox')
CFG = os.path.join(_TOOLS, 'c2/private-qa.json')
TOKEN = os.environ.get('PRIVATE_QA_TOKEN', '')

if not TOKEN:
    try:
        TOKEN = json.load(open(CFG)).get('token', '')
    except Exception:
        pass
if not TOKEN:
    TOKEN = secrets.token_hex(16)
    try:
        os.makedirs(os.path.dirname(CFG), exist_ok=True)
        json.dump({'url': 'http://127.0.0.1:8899/scan', 'token': TOKEN},
                  open(CFG, 'w'), indent=1)
    except Exception:
        pass


def dexec(*args, timeout=120):
    """容器内执行(样本路径用容器视角 /opt/tools/...)。"""
    cmd = ['docker', 'exec', CONTAINER, *args] if CONTAINER else list(args)
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def scan(_path_host, name):
    """host 路径 → 容器路径(共享挂载), 双引擎。(path_host 仅作调用侧溯源——扫描走容器位)"""
    cpath = f'/opt/tools/c2/qa-inbox/{name}'
    sigs = []
    # ClamAV
    r1 = dexec('clamscan', '--no-summary', cpath, timeout=120)
    if r1.returncode == 0 and 'FOUND' in r1.stdout:
        sigs.append(r1.stdout.split('FOUND')[0].split(':')[-1].strip())
    # YARA 全规则
    rules = sorted(glob.glob(os.path.join(_TOOLS, 'c2/yara-rules/*.yar'))
                   + glob.glob(os.path.join(_TOOLS, 'c2/yara-rules/*.yara')))
    for rf in rules:
        crule = rf.replace(_TOOLS, '/opt/tools')
        r2 = dexec('yara', crule, cpath, timeout=60)
        if r2.stdout.strip():
            sigs.append(r2.stdout.split()[0])
    return {'detected': bool(sigs), 'signature': ','.join(sigs[:5]),
            'engine': 'PrivateRack(clamav+%d yara rules)' % len(rules)}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == '/health':
            self._json({'ok': True, 'engines': ['clamav', 'yara'],
                        'container': CONTAINER})
        else:
            self._json({'error': 'not found'}, 404)

    def do_POST(self):
        if self.path != '/scan':
            self._json({'error': 'not found'}, 404); return
        if self.headers.get('X-SPECTRE-Token', '') != TOKEN:
            self._json({'error': 'bad token'}, 401); return
        ct = self.headers.get('Content-Type', '')
        bnd = ct.split('boundary=')[-1].strip().encode() if 'boundary=' in ct else None
        ln = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(ln)
        payload = b''
        if bnd:
            for part in body.split(b'--' + bnd):
                if b'Content-Disposition' in part and b'\r\n\r\n' in part:
                    payload = part.split(b'\r\n\r\n', 1)[1]
                    if payload.endswith(b'\r\n'):
                        payload = payload[:-2]
                    break
        if not payload:
            self._json({'error': 'no sample part'}, 400); return
        os.makedirs(INBOX, exist_ok=True)
        name = 's-%d.bin' % int(subprocess.run(['date', '+%s%N'],
                        capture_output=True, text=True).stdout.strip()[-12:])
        sp = os.path.join(INBOX, name)
        try:
            open(sp, 'wb').write(payload)
            self._json(scan(sp, name))
        finally:
            try: os.unlink(sp)
            except OSError: pass

    def _json(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == '__main__':
    from http.server import HTTPServer
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    print(f'private-qa-server (real rack) on :{port} container={CONTAINER}', flush=True)
    HTTPServer(('127.0.0.1', port), H).serve_forever()
