#!/usr/bin/env python3
"""phish-track — 钓鱼追踪端点(HTTP) + 数据收集
用法:
  phish-track.py serve --port 8080 --db /tmp/phish-track.json
  phish-track.py report --db /tmp/phish-track.json
追踪点: /open.gif (打开) / /click/<uid> (点击) / /submit (凭据提交)
"""
import sys, os, json, time, hashlib, base64
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

DB_FILE = '/opt/tools/phish/track.json'  # 映射宿主 tools/phish/(campaigns API 可读)
import os as _os; _os.makedirs('/opt/tools/phish', exist_ok=True)

import time as _time
def scope_gate_full():
    """完整授权门(同 c2-qa): targets+window 双校验,exit 75"""
    import json as _json
    SCOPE = '/opt/tools/c2/scope.json'
    if not os.path.exists(SCOPE):
        print('SCOPE-REJECT: no scope file', file=sys.stderr); sys.exit(75)
    try:
        sc = _json.load(open(SCOPE))
        now = _time.strftime('%Y-%m-%dT%H:%M:%SZ', _time.gmtime())
        ok = (sc.get('targets') and
              sc['window']['start'] and sc['window']['end'] and
              sc['window']['start'] <= now <= sc['window']['end'])
    except Exception:
        ok = False
    if not ok:
        print('SCOPE-REJECT: empty targets or out of window', file=sys.stderr)
        sys.exit(75)
    return sc

def load_db():
    try: return json.load(open(DB_FILE))
    except: return {'events': []}

def save_db(db):
    json.dump(db, open(DB_FILE, 'w'), indent=1)

def add_event(db, kind, uid, extra=None):
    ev = {'kind': kind, 'uid': uid, 'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    if extra: ev.update(extra)
    db['events'].append(ev)
    save_db(db)
    print(f'[track] {kind} uid={uid}', flush=True)

def _scope_ok():
    """V2: 逐请求 scope 复查——serve() 启动时一次校验后撤权不停服
    (writer 实证: 撤 scope 后运行中的 serve 仍接受 /submit)。"""
    try:
        sc = json.load(open('/opt/tools/c2/scope.json'))
        import time as _t
        now = _t.strftime('%Y-%m-%dT%H:%M:%SZ', _t.gmtime())
        return bool(sc.get('targets') and
                    sc['window']['start'] <= now <= sc['window']['end'])
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
            add_event(db, 'open', uid, {'ua': self.headers.get('User-Agent', ''), 'ip': self.client_address[0]})
            gif = base64.b64decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
            self.send_response(200)
            self.send_header('Content-Type', 'image/gif')
            self.send_header('Content-Length', str(len(gif)))
            self.end_headers()
            self.wfile.write(gif)
        elif u.path.startswith('/click/'):
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
            cred_hash = hashlib.sha256(str(qs).encode()).hexdigest()[:16]
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
    scope_gate_full()  # F10: 完整授权门(targets+window)
    print(f'[phish-track] listening :{port}', flush=True)
    HTTPServer(('0.0.0.0', port), TrackHandler).serve_forever()

def report():
    db = load_db()
    events = db['events']
    by_uid = {}
    for ev in events:
        uid = ev['uid']
        if uid not in by_uid:
            by_uid[uid] = {'open': 0, 'click': 0, 'submit': 0, 'events': []}
        by_uid[uid][ev['kind']] += 1
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
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    if sys.argv[1] == 'serve':
        port = int(sys.argv[2]) if len(sys.argv) > 2 else 8080
        serve(port)
    elif sys.argv[1] == 'report':
        report()
