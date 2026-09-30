"""Gateway configuration constants (single source of truth)."""

import os

#: Public path prefix served by caddy; gateway strips it internally.
PREFIX = "/spectre"

#: 全部可经环境变量覆盖(部署审计 R32: 此前全硬编码, 新用户必须手改
#: 源码才能换端口/路径——与后端 ENV 风格对齐)。示例见 deploy/README.md。
BIND_HOST = os.environ.get("GATEWAY_BIND_HOST", "127.0.0.1")
BIND_PORT = int(os.environ.get("GATEWAY_PORT", "8081"))

#: Static SPA built by console/ (`npm run build`).
DIST_DIR = os.environ.get("GATEWAY_DIST_DIR", "../console/dist")

#: Credentials and audit locations.
AUTH_DIR = os.environ.get("SPECTRE_AUTH_DIR", "/etc/spectre-auth")
PASSWD_FILE = os.path.join(AUTH_DIR, "passwd")
LOG_DIR = os.environ.get("GATEWAY_LOG_DIR", "/var/log/spectre-console")
LOG_FILE = os.path.join(LOG_DIR, "auth.log")

#: Upstream agent runtime for /spectre/api/*.
RUNTIME_HOST = os.environ.get("RUNTIME_HOST", "127.0.0.1")
RUNTIME_PORT = int(os.environ.get("RUNTIME_PORT", "8090"))
#: Internal token the runtime enforces on every /api route.
RUNTIME_TOKEN = os.environ.get("INTERNAL_TOKEN", "")

#: Session cookie and lifetime。纯 HTTP 非 localhost 部署(测试)可置
#: GATEWAY_INSECURE_COOKIE=1 关闭 Secure 位; 生产必须走 TLS。
COOKIE_SECURE = os.environ.get("GATEWAY_INSECURE_COOKIE", "") != "1"
COOKIE_NAME = "spectre_sess"
SESSION_IDLE_SECS = 3600
SESSION_ABSOLUTE_SECS = 12 * 3600

#: Brute-force lockout.
MAX_FAILS = 5
FAIL_WINDOW_SECS = 900
LOCKOUT_SECS = 900

MAX_BODY_BYTES = 4096

#: Security headers applied to every response.
BASE_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000",
    "X-Robots-Tag": "noindex, nofollow",
}

CSP_APP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; "
    "img-src 'self' data:; font-src 'self'; connect-src 'self'; "
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)
CSP_LOGIN = (
    "default-src 'none'; style-src 'unsafe-inline'; "
    "form-action 'self'; frame-ancestors 'none'"
)

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}

