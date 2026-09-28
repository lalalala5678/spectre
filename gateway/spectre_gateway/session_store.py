"""F72: gateway sessions are memory-only — every deploy (restart of
spectre-console, which IS the gateway) logs out all users. Persist the
sha256-keyed session table to a compact JSON sidecar: write-behind on
issue/revoke/refresh, load at boot with expiry re-check. Tokens never
touch disk in plaintext (only sha256 keys), same threat model as memory.
"""
import json
import os
import threading
import time

STORE = "/var/lib/spectre/gateway-sessions.json"
_DEBOUNKE = 0.5


class SessionPersistence:
    def __init__(self, path=STORE):
        self._path = path
        self._lock = threading.Lock()
        self._dirty = False
        self._last_write = 0.0

    def load(self):
        """Return the persisted {sha256key: session} map (expired pruned)."""
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return {}
        from . import config
        now = time.time()
        live = {}
        for key, s in data.items():
            try:
                if (now - s["last_ts"] <= config.SESSION_IDLE_SECS
                        and now - s["login_ts"] <= config.SESSION_ABSOLUTE_SECS):
                    live[key] = s
            except (KeyError, TypeError):
                continue
        return live

    def mark_dirty(self):
        with self._lock:
            self._dirty = True

    def flush_if_dirty(self, sessions, force=False):
        """Write-behind: coalesce rapid mutations (login bursts) into
        one fsync'd write per debounce window. force=True bypasses the
        debounce — terminal writes (revoke) must land BEFORE the
        process can die, or a restart resurrects revoked sessions."""
        with self._lock:
            if not self._dirty:
                return
            now = time.time()
            if not force and now - self._last_write < _DEBOUNKE:
                return
            self._dirty = False
            self._last_write = now
        tmp = self._path + ".tmp"
        os.makedirs(os.path.dirname(self._path), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(sessions, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self._path)
