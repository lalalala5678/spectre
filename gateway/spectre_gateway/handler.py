"""HTTP request handling: auth gate → static | login | logout | API proxy."""

import http.cookies
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler

from . import config, pages, proxy, static_files
from .security import Security, audit


class GatewayHandler(BaseHTTPRequestHandler):
    """One shared Security instance is injected by `serve()`."""

    security: Security = None  # set at startup
    server_version = "spectre-gw"
    sys_version = ""

    def version_string(self):
        return self.server_version  # 消灭默认拼接的尾随空格
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # access is audited explicitly; skip stderr noise

    # ---------- helpers ----------

    def client_ip(self):
        if not config.TRUST_PROXY:
            return self.client_address[0]
        forwarded = self.headers.get("X-Forwarded-For", "")
        if forwarded:
            # last hop = the trusted proxy appended real client IP;
            # [0] let attackers spoof fresh IPs and bypass lockout
            return forwarded.split(",")[-1].strip()
        return self.client_address[0]

    def _cookie_token(self):
        jar = http.cookies.SimpleCookie(self.headers.get("Cookie", ""))
        if config.COOKIE_NAME in jar:
            return jar[config.COOKIE_NAME].value
        return None

    def _session(self):
        return self.security.check_session(self._cookie_token())

    def _send(self, status, body=b"", ctype="text/html; charset=utf-8",
              headers=None, csp=config.CSP_APP):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Security-Policy", csp)
        for name, value in config.BASE_HEADERS.items():
            self.send_header(name, value)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _drain(self):
        """R4-2: 早退路径排空请求体——keep-alive 下残留 body 字节会被
        当作下一请求的请求行解析(实测 303→501 解析错位)。超上限或读
        异常直接断连(body 既不可信也不必留)。"""
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.close_connection = True
            return
        if length <= 0:
            return
        if length > config.MAX_BODY_BYTES:
            self.close_connection = True
            return
        try:
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 65536))
                if not chunk:
                    break
                remaining -= len(chunk)
        except OSError:
            self.close_connection = True

    def _redirect(self, location, headers=None):
        self._send(303, headers={"Location": location, **(headers or {})})

    # ---------- GET/HEAD ----------

    def do_GET(self):
        split = urllib.parse.urlsplit(self.path)
        path = split.path
        if not path.startswith(config.PREFIX):
            # 根路径/杂路径直接引到应用前缀(首次访问体验)
            if path in ("", "/"):
                return self._send(
                    302, headers={"Location": config.PREFIX + "/"})
            return self._send(404, b"not found")
        rel = path[len(config.PREFIX):] or "/"

        if rel.startswith("/api/") and split.query:

            rel += "?" + split.query  # ?since=/?ws= must reach upstream

        if rel.split("?")[0] == "/login":
            query = urllib.parse.parse_qs(
                urllib.parse.urlsplit(self.path).query,
            )
            key = query.get("e", [""])[0]
            return self._send(
                200, pages.render_login(key).encode(),
                headers={"Cache-Control": "no-store"}, csp=config.CSP_LOGIN,
            )

        if rel.startswith("/api/"):
            if not self._session():
                audit("auth_redirect", ip=self.client_ip(), path=rel)
                self._drain()  # R4-2: keep-alive 体排空
                return self._redirect(config.PREFIX + "/login")
            return self._proxy(rel)

        if rel == "/logout":
            token = self._cookie_token()
            if token:
                self.security.revoke_session(token)
                audit("logout", ip=self.client_ip())
            clear = (
                f"{config.COOKIE_NAME}=; Path={config.PREFIX}; Max-Age=0; "
                "HttpOnly; SameSite=Strict"
                + ("; Secure" if config.COOKIE_SECURE else "")
            )
            return self._redirect(
                config.PREFIX + "/login", headers={"Set-Cookie": clear},
            )

        if not self._session():
            audit("auth_redirect", ip=self.client_ip(), path=rel)
            self._drain()  # R4-2
            return self._redirect(config.PREFIX + "/login")

        if rel in ("", "/"):
            rel = "/index.html"
        return self._serve_static(rel)

    do_HEAD = do_GET

    def _serve_static(self, rel):
        """Serve a file from DIST_DIR with traversal protection."""
        target = static_files.resolve(rel)
        if target is None:
            audit("static_miss", ip=self.client_ip(), path=rel)
            return self._send(404, b"not found")
        with open(target, "rb") as handle:
            body = handle.read()
        return self._send(
            200, body,
            ctype=static_files.content_type(target),
            headers={"Cache-Control": static_files.cache_policy(rel)},
        )

    # ---------- POST ----------

    def do_PUT(self):
        # API mutations (projects/prefs/revise…) ride PUT through the
        # same authenticated proxy path as POST.
        split = urllib.parse.urlsplit(self.path)
        path = split.path
        if not path.startswith(config.PREFIX):
            return self._send(404, b"not found")
        # keep the QUERY STRING — DELETE/PUT endpoints address resources
        # by query params (?agentKey=&name= / ?name=); dropping it once
        # turned every such call into a 400 (button E2E caught it).
        rel = path[len(config.PREFIX):] + (
            ('?' + split.query) if split.query else '')
        if rel.split('?')[0].startswith("/api/"):
            if not self._session():
                audit("auth_redirect", ip=self.client_ip(), path=rel)
                self._drain()  # R4-2: keep-alive 体排空
                return self._redirect(config.PREFIX + "/login")
            return self._proxy(rel)
        return self._send(405, b"method not allowed")

    def do_DELETE(self):
        split = urllib.parse.urlsplit(self.path)
        path = split.path
        if not path.startswith(config.PREFIX):
            return self._send(404, b"not found")
        # keep the QUERY STRING — DELETE/PUT endpoints address resources
        # by query params (?agentKey=&name= / ?name=); dropping it once
        # turned every such call into a 400 (button E2E caught it).
        rel = path[len(config.PREFIX):] + (
            ('?' + split.query) if split.query else '')
        if rel.split('?')[0].startswith("/api/"):
            if not self._session():
                audit("auth_redirect", ip=self.client_ip(), path=rel)
                self._drain()  # R4-2: keep-alive 体排空
                return self._redirect(config.PREFIX + "/login")
            return self._proxy(rel)
        return self._send(405, b"method not allowed")

    def do_POST(self):
        split = urllib.parse.urlsplit(self.path)
        path = split.path
        if not path.startswith(config.PREFIX):
            return self._send(404, b"not found")
        rel = path[len(config.PREFIX):] + (
            ('?' + split.query) if split.query else '')

        if rel.split('?')[0].startswith("/api/"):
            if not self._session():
                audit("auth_redirect", ip=self.client_ip(), path=rel)
                self._drain()  # R4-2: keep-alive 体排空
                return self._redirect(config.PREFIX + "/login")
            return self._proxy(rel)
        if rel.split("?")[0] == "/login":
            return self._handle_login()
        return self._send(404, b"not found")

    def _handle_login(self):
        ip = self.client_ip()
        if self.security.is_locked(ip):
            audit("login_blocked_lockout", ip=ip)
            self._drain()  # R4-2
            return self._redirect(config.PREFIX + "/login?e=lock")

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = config.MAX_BODY_BYTES + 1
        if length > config.MAX_BODY_BYTES:
            audit("request_413", ip=ip, length=length)  # R4-2: 记账补齐
            self.close_connection = True
            return self._send(413, b"too large")

        raw = self.rfile.read(length).decode("utf-8", "replace")
        form = urllib.parse.parse_qs(raw, keep_blank_values=True)
        user = (form.get("user") or [""])[0][:64]
        pw = (form.get("pw") or [""])[0]

        time.sleep(0.5)  # constant failure delay
        if not self.security.verify_credentials(user, pw):
            if self.security.record_failure(ip):
                audit("lockout", ip=ip)
            else:
                audit("login_fail", ip=ip)
            return self._redirect(config.PREFIX + "/login?e=cred")

        self.security.clear_failures(ip)
        token = self.security.issue_session(
            user, ip, self.headers.get("User-Agent"),
        )
        audit("login_ok", user=user, ip=ip)
        cookie = (
            f"{config.COOKIE_NAME}={token}; Path={config.PREFIX}; "
            f"Max-Age={config.SESSION_ABSOLUTE_SECS}; "
            "HttpOnly; SameSite=Strict"
            + ("; Secure" if config.COOKIE_SECURE else "")
        )
        return self._redirect(
            config.PREFIX + "/", headers={"Set-Cookie": cookie},
        )

    # ---------- proxy ----------

    def _proxy(self, rel):
        """Forward an authenticated /api/* request to the agent runtime."""
        try:
            proxy.proxy(self, rel)
        except proxy.ProxyError as error:
            self._send(error.status, str(error).encode())


def serve():
    """Entry point: wire state and start the threaded HTTP server."""
    import os
    from http.server import ThreadingHTTPServer

    loopback = ("127.0.0.1", "localhost")
    if config.BIND_HOST not in loopback and config.TRUST_PROXY:
        print("[gateway] 警告: 公网绑定且信任 XFF——直连者可自旋 X-Forwarded-For "
              "绕过锁定; 建议仅绑定环回由反代暴露, 或设 GATEWAY_TRUST_PROXY=0", flush=True)
    try:
        os.makedirs(config.LOG_DIR, exist_ok=True)
    except OSError as e:
        print(f"[gateway] 日志目录不可用({config.LOG_DIR}): {e}"
              f" — 审计日志将只写 stdout", flush=True)
    if not os.path.isfile(config.PASSWD_FILE):
        raise SystemExit(
            f"FATAL: {config.PASSWD_FILE} missing — 先运行 "
            f"python3 spectre-passwd.py add <user> 创建账号"
            f"(注意: 建号与网关须同一 SPECTRE_AUTH_DIR, 两边不一致即此错)")
    # F9(部署审计四轮): 空 INTERNAL_TOKEN 此前静默启动, 登录后所有 API 401
    if not config.RUNTIME_TOKEN:
        raise SystemExit(
            "FATAL: INTERNAL_TOKEN 未设置 — 网关反代 /api 需要 "
            "runtime 相同的令牌(backend/.env 里的 INTERNAL_TOKEN)")
    if config.RUNTIME_TOKEN.lower().startswith('change-me'):
        raise SystemExit(
            "FATAL: INTERNAL_TOKEN 仍是占位值 — 填入与 backend/.env 相同的真实随机令牌")

    GatewayHandler.security = Security()
    server = ThreadingHTTPServer(
        (config.BIND_HOST, config.BIND_PORT), GatewayHandler,
    )
    server.daemon_threads = True
    audit("gateway_start",
          bind=f"{config.BIND_HOST}:{config.BIND_PORT}",
          dist=config.DIST_DIR, pid=os.getpid())
    server.serve_forever()
