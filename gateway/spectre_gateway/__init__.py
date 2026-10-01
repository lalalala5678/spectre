"""SPECTRE auth gateway package.

Serves the console SPA, terminates sessions, and reverse-proxies the
backend API (including SSE) — the only path between the public caddy
frontend and the loopback-only agent runtime.
"""

__version__ = "0.4.0"  # CS20-8: 与 backend/console/lockfile 对齐
