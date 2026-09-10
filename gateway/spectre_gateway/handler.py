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
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # access is audited explicitly; skip stderr noise

    # ---------- helpers ----------

    def client_ip(self):
        forwarded = self.headers.get("X-Forwarded-For", "")
        if forwarded:
            return forwarded.split(",")[0].strip()
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

    def _redirect(self, location, headers=None):
        self._send(303, headers={"Location": location, **(headers or {})})

    # ---------- GET/HEAD ----------

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if not path.startswith(config.PREFIX):
            return self._send(404, b"not found")
        rel = path[len(config.PREFIX):] or "/"

        if rel == "/login":
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
                return self._redirect(config.PREFIX + "/login")
            return self._proxy(rel)

        if rel == "/logout":
            token = self._cookie_token()
            if token:
                self.security.revoke_session(token)
                audit("logout", ip=self.client_ip())
            clear = (
                f"{config.COOKIE_NAME}=; Path={config.PREFIX}; Max-Age=0; "
                "HttpOnly; SameSite=Strict; Secure"
            )
            return self._redirect(
                config.PREFIX + "/login", headers={"Set-Cookie": clear},
            )

        if not self._session():
            audit("auth_redirect", ip=self.client_ip(), path=rel)
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
        rel = path[len(config.PREFIX):] + (('?' + split.query) if split.query else '')
        if rel.split('?')[0].startswith("/api/"):
            if not self._session():
                audit("auth_redirect", ip=self.client_ip(), path=rel)
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
        rel = path[len(config.PREFIX):] + (('?' + split.query) if split.query else '')
        if rel.split('?')[0].startswith("/api/"):
            if not self._session():
                audit("auth_redirect", ip=self.client_ip(), path=rel)
                return self._redirect(config.PREFIX + "/login")
            return self._proxy(rel)
        return self._send(405, b"method not allowed")

    def do_POST(self):
        split = urllib.parse.urlsplit(self.path)
        path = split.path
        if not path.startswith(config.PREFIX):
            return self._send(404, b"not found")
        rel = path[len(config.PREFIX):] + (('?' + split.query) if split.query else '')

        if rel.split('?')[0].startswith("/api/"):
            if not self._session():
                audit("auth_redirect", ip=self.client_ip(), path=rel)
                return self._redirect(config.PREFIX + "/login")
            return self._proxy(rel)
        if rel == "/login":
            return self._handle_login()
        return self._send(404, b"not found")

    def _handle_login(self):
        ip = self.client_ip()
        if self.security.is_locked(ip):
            audit("login_blocked_lockout", ip=ip)
            return self._redirect(config.PREFIX + "/login?e=lock")

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = config.MAX_BODY_BYTES + 1
        if length > config.MAX_BODY_BYTES:
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
            "HttpOnly; SameSite=Strict; Secure"
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

    os.makedirs(config.LOG_DIR, exist_ok=True)
    if not os.path.isfile(config.PASSWD_FILE):
        raise SystemExit(f"FATAL: {config.PASSWD_FILE} missing")

    GatewayHandler.security = Security()
    server = ThreadingHTTPServer(
        (config.BIND_HOST, config.BIND_PORT), GatewayHandler,
    )
    server.daemon_threads = True
    audit("gateway_start",
          bind=f"{config.BIND_HOST}:{config.BIND_PORT}",
          dist=config.DIST_DIR, pid=os.getpid())
    server.serve_forever()
