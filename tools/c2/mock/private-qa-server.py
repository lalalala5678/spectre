#!/usr/bin/env python3
"""private-qa-server — 私架沙箱 mock(引擎适配器联调样例)。
契约(c2-qa.py eng_private 对端):
  POST /scan  multipart 字段 sample;鉴权头 X-SPECTRE-Token
  响应 JSON {"detected":bool,"signature":"...","engine":"PrivateSandbox-Mock"}
  行为:用 /opt/tools/c2/yara-rules/engine_matrix.yar 扫样本,任一规则命中=detected
  GET /health → {"ok":true}
用法: python3 private-qa-server.py [port=8899]
真私架替换:同契约换真实沙箱即可,c2-qa 侧零改动。
"""
import sys, os, json, subprocess, tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer

RULES = '/opt/tools/c2/yara-rules/engine_matrix.yar'
TOKEN = os.environ.get('PRIVATE_QA_TOKEN', 'spectre-mock-token')

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == '/health':
            self._json({'ok': True})
        else:
            self._json({'error': 'not found'}, 404)

    def do_POST(self):
        if self.path != '/scan':
            self._json({'error': 'not found'}, 404); return
        if self.headers.get('X-SPECTRE-Token', '') != TOKEN:
            self._json({'error': 'bad token'}, 401); return
        ct = self.headers.get('Content-Type', '')
        bnd = ct.split('boundary=')[-1].strip().encode() if 'boundary=' in ct else None
        # CS71-4/CS72-1: 族先例两段式 CL 守卫(第 4/5 例收口——非数字/
        # 负值/无上界三模式, 单线程 HTTPServer 永久 wedge)。
        try:
            ln = int(self.headers.get('Content-Length', 0) or 0)
        except (ValueError, TypeError):
            self.send_response(400); self.end_headers()
            return
        if ln < 0 or ln > 1_048_576:
            self.send_response(413); self.end_headers()
            return
        body = self.rfile.read(ln)
        # 粗解析 multipart:取第一个文件 part 的载荷
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
        with tempfile.NamedTemporaryFile(suffix='.sample', delete=False) as t:
            t.write(payload); sp = t.name
        try:
            r = subprocess.run(['yara', RULES, sp], capture_output=True, text=True, timeout=60)
            hit = r.stdout.split()[0] if r.stdout.strip() else ''
        finally:
            os.unlink(sp)
        self._json({'detected': bool(hit), 'signature': hit, 'engine': 'PrivateSandbox-Mock'})

    def _json(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    print(f'private-qa-server mock on :{port} (token={TOKEN[:8]}...)', flush=True)
    HTTPServer(('127.0.0.1', port), H).serve_forever()
