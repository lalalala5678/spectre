#!/usr/bin/env python3
"""phish-track — 钓鱼追踪端点(HTTP) + 数据收集
用法:
  phish-track.py serve --port 8080   # 事件库缺省=数据根 tools/phish/track.json
  phish-track.py report              # 同上, --db 可覆盖
追踪点: /open.gif (打开) / /click/<uid> (点击) / /submit (凭据提交)
"""
import os, json, time, hashlib, base64, re
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from _common import _data_root, scope_gate_full, edusrc_gate_phish as edusrc_gate


def _phish_dir():
    return os.path.join(_data_root(), 'phish')
DB_FILE = f'{_phish_dir()}/track.json'  # campaigns API 可读(phish-funnel 同目录)
os.makedirs(_phish_dir(), exist_ok=True)


def load_db():
    # V6: 共享锁读(与写锁互斥)
    import fcntl
    try:
        with open(DB_FILE + '.lock', 'w') as lf:
            fcntl.flock(lf, fcntl.LOCK_SH)
            try:
                return json.load(open(DB_FILE))
            finally:
                fcntl.flock(lf, fcntl.LOCK_UN)
    except Exception:
        return {'events': []}

def save_db(db):
    # V6: 排他文件锁——phishlet-proxy 与 track 并发写同库曾互踩
    # (agent 实战目击 proxy 事件消失)。load-modify-save 全程持锁。
    import fcntl
    with open(DB_FILE + '.lock', 'w') as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            json.dump(db, open(DB_FILE, 'w'), indent=1, ensure_ascii=False)
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)

def add_event(db, kind, uid, extra=None):
    # V6b: 整个 read-modify-write 持排他锁——此前锁只在 save 段,
    # 两进程(如 track+proxy)各自 load 旧快照后互覆盖(实测丢 12/200)。
    ev = {'kind': kind, 'uid': uid, 'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    if extra: ev.update(extra)
    import fcntl
    with open(DB_FILE + '.lock', 'w') as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            # 锁内裸读——load_db 自带 SH 锁会与已持 EX 死锁(同进程双 fd)
            try:
                cur = json.load(open(DB_FILE))
            except Exception:
                cur = {'events': []}
            cur['events'].append(ev)
            json.dump(cur, open(DB_FILE, 'w'), indent=1, ensure_ascii=False)
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)
    print(f'[track] {kind} uid={uid}', flush=True)


def _scope_ok():
    """V2: 逐请求 scope 复查——serve() 启动时一次校验后撤权不停服
    (writer 实证: 撤 scope 后运行中的 serve 仍接受 /submit)。
    CS44-F10: 谓词收口单源门布尔版(此前本地副本丢三必填之 exercise,
    phish-send 同款劣化副本已删的先例)。"""
    try:
        scope_gate_full()
        return True
    except SystemExit:
        return False
    except Exception:
        return False

class TrackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        # V2: 逐请求 scope 复查
        if not _scope_ok():
            self.send_response(503); self.end_headers()
            self.wfile.write(b'scope revoked')
            return
        u = urlparse(self.path)
        db = load_db()
        if u.path.endswith('.gif') or u.path == '/open':
            # Tracking pixel (1x1 transparent GIF)
            qs = parse_qs(u.query)
            uid = qs.get('uid', ['unknown'])[0]
            # V5 修复: phish-send v2 生成路径式 /o/<uid>.gif(skill 规范),
            # 此前只认 ?uid= 查询参数 → 所有 open 事件 uid=unknown,
            # 逐收件人打开归因完全失效。
            m = re.match(r'^/(?:o|open)/([A-Za-z0-9_-]+?)\.gif$', u.path)
            if m:
                uid = m.group(1)
            add_event(db, 'open', uid, {'ua': self.headers.get('User-Agent', ''), 'ip': self.client_address[0]})
            gif = base64.b64decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
            self.send_response(200)
            self.send_header('Content-Type', 'image/gif')
            self.send_header('Content-Length', str(len(gif)))
            self.end_headers()
            self.wfile.write(gif)
        elif u.path.startswith('/click/') or u.path.startswith('/r/'):
            # V5 修复: /r/<uid> 是 phish-send v2 的点击 URL 规范
            # (https://域/r/<uid>),此前只认 /click/<uid> →
            # 真实邮件按钮点击落到默认分支(200 Service Portal),全部漏记。
            uid = u.path.split('/')[2]
            add_event(db, 'click', uid, {'ua': self.headers.get('User-Agent', ''), 'ip': self.client_address[0]})
            self.send_response(302)
            self.send_header('Location', '/')  # Redirect to landing page
            self.end_headers()
        else:
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(b'<h1>Service Portal</h1>')

    def do_POST(self):
        # V2: 逐请求 scope 复查
        if not _scope_ok():
            self.send_response(503); self.end_headers()
            self.wfile.write(b'scope revoked')
            return
        u = urlparse(self.path)
        # V3: Content-Length 校验——负值挂死(单线程服务永久 wedged)/
        # 超大无界读/非数字 ValueError(writer 三项全实证)。
        try:
            length = int(self.headers.get('Content-Length', 0) or 0)
        except (ValueError, TypeError):
            self.send_response(400); self.end_headers()
            return
        if length < 0 or length > 1_048_576:
            self.send_response(413); self.end_headers()
            return
        body = self.rfile.read(length).decode(errors='replace') if length else ''
        db = load_db()
        if u.path == '/submit':
            qs = parse_qs(body)
            uid = qs.get('uid', ['unknown'])[0]
            # Hash credentials immediately (never store plaintext)
            # 优化项(seq1914): 只哈希凭据字段——str(qs) 曾把 uid 卷入,
            # 同凭据不同收件人哈希不同,不可比对
            cred_only = {k: v for k, v in qs.items() if k.lower() != 'uid'}
            cred_hash = hashlib.sha256(json.dumps(cred_only, sort_keys=True).encode()).hexdigest()[:16]
            add_event(db, 'submit', uid, {'cred_hash': cred_hash, 'ip': self.client_address[0]})
            self.send_response(302)
            self.send_header('Location', '/success')
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *a):
        pass  # Quiet (tracking data goes to db, not access log)

def serve(port):
    edusrc_gate()
    scope_gate_full()  # F10: 完整授权门(targets+exercise+window 三必填, CS37-F5)
    print(f'[phish-track] listening :{port}', flush=True)
    HTTPServer(('0.0.0.0', port), TrackHandler).serve_forever()

def report():
    edusrc_gate()
    db = load_db()
    events = db['events']
    by_uid = {}
    for ev in events:
        uid = ev['uid']
        if uid not in by_uid:
            by_uid[uid] = {'open': 0, 'click': 0, 'submit': 0, 'events': []}
        # V5 修复: 未知 kind(如 phish-proxy 合入的 session-captured)
        # 此前直接 KeyError 崩掉 report()
        by_uid[uid][ev['kind']] = by_uid[uid].get(ev['kind'], 0) + 1
        by_uid[uid]['events'].append(ev)
    total = len(by_uid)
    opens = sum(1 for v in by_uid.values() if v['open'] > 0)
    clicks = sum(1 for v in by_uid.values() if v['click'] > 0)
    submits = sum(1 for v in by_uid.values() if v['submit'] > 0)
    print(f'Campaign Report')
    print(f'  Unique targets: {total}')
    print(f'  Opens:    {opens} ({opens*100//max(total,1)}%)')
    print(f'  Clicks:   {clicks} ({clicks*100//max(total,1)}%)')
    print(f'  Submits:  {submits} ({submits*100//max(total,1)}%)')
    print(f'  Funnel:   send → open → click → submit')
    for uid, v in sorted(by_uid.items()):
        marks = '✓' if v['submit'] else ('●' if v['click'] else ('○' if v['open'] else ' '))
        print(f'  [{marks}] {uid}: open={v["open"]} click={v["click"]} submit={v["submit"]}')

if __name__ == '__main__':
    # V5 修复: 文档用法是 `serve --port N --db F`,旧代码只认 sys.argv[2] 位置参数
    # (--port → int() ValueError 崩溃;--db 被完全忽略,DB_FILE 硬编码)。
    import argparse
    ap = argparse.ArgumentParser(prog='phish-track')
    ap.add_argument('mode', choices=['serve', 'report'])
    ap.add_argument('port_pos', nargs='?', type=int, help='兼容旧位置参数形式')
    ap.add_argument('--port', type=int)
    ap.add_argument('--db', help='事件库路径(缺省=数据根 tools/phish/track.json, 双运行位)')
    a = ap.parse_args()
    if a.db:
        DB_FILE = a.db  # load_db/save_db 均引用模块全局,重绑即生效
    if a.mode == 'serve':
        port = a.port or a.port_pos or 8080
        serve(port)
    else:
        report()
