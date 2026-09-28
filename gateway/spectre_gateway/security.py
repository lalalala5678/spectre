"""Authentication core: password verification, sessions, lockout, audit.

All mutable state lives here behind a lock; the HTTP handler stays
stateless. One instance of :class:`Security` is shared by the server.
"""

import base64
import hashlib
import hmac
import json
import secrets
import sys
import threading
import time

from . import config

_DUMMY_SALT = b"\x00" * 16
_DUMMY_HASH = hashlib.scrypt(
    b"!", salt=_DUMMY_SALT, n=2 ** 15, r=8, p=1, dklen=32,
    maxmem=128 * 1024 * 1024,
)


def audit(event, **fields):
    """Append one JSONL record to the audit log and stderr."""
    record = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "event": event,
        **fields,
    }
    line = json.dumps(record, ensure_ascii=False)
    try:
        with open(config.LOG_FILE, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass
    print(line, file=sys.stderr, flush=True)


class Security:
    """Session store + per-IP failure tracking + credential checks."""

    def __init__(self):
        self._lock = threading.Lock()
        self._sessions = {}   # sha256(token) -> {user, ip, ua, login_ts, last_ts}
        self._failtrack = {}  # ip -> {n, window_start, locked_until}
        # F72: memory-only sessions logged everyone out on every deploy
        # (spectre-console restart IS the gateway restart). Load the
        # compact sha256-keyed sidecar; write-behind keeps it current.
        from .session_store import SessionPersistence
        self._persist = SessionPersistence()
        self._sessions = self._persist.load()

    # ---------- credentials ----------

    @staticmethod
    def _scrypt(pw, salt, n, r, p, dklen):
        return hashlib.scrypt(
            pw.encode(), salt=salt, n=n, r=r, p=p, dklen=dklen,
            maxmem=128 * 1024 * 1024,
        )

    def verify_credentials(self, user, pw):
        """Check `user:scrypt$...` lines; unknown users burn equal time."""
        user = (user or "").strip()
        record = None
        try:
            with open(config.PASSWD_FILE, "r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if line and not line.startswith("#") \
                            and line.split(":", 1)[0] == user:
                        record = line.split(":", 1)[1]
                        break
        except OSError:
            pass
        if record is None:
            got = self._scrypt(pw or "", _DUMMY_SALT, 2 ** 15, 8, 1, 32)
            return hmac.compare_digest(got, _DUMMY_HASH) and False
        try:
            _, n, r, p, salt_b64, hash_b64 = record.split("$")
            salt = base64.b64decode(salt_b64)
            want = base64.b64decode(hash_b64)
            got = self._scrypt(pw or "", salt, int(n), int(r), int(p), len(want))
        except Exception:
            return False
        return hmac.compare_digest(got, want)

    # ---------- lockout ----------

    def is_locked(self, ip):
        with self._lock:
            state = self._failtrack.get(ip)
            return bool(state and state["locked_until"] > time.time())

    def record_failure(self, ip):
        """Count a failure; returns True when the IP just became locked."""
        now = time.time()
        with self._lock:
            state = self._failtrack.get(ip)
            if not state or now - state["window_start"] > config.FAIL_WINDOW_SECS:
                state = {"n": 0, "window_start": now, "locked_until": 0}
                self._failtrack[ip] = state
            state["n"] += 1
            if state["n"] >= config.MAX_FAILS:
                state["locked_until"] = now + config.LOCKOUT_SECS
                return True
            return False

    def clear_failures(self, ip):
        with self._lock:
            self._failtrack.pop(ip, None)

    # ---------- sessions ----------

    def issue_session(self, user, ip, user_agent):
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self._lock:
            self._sessions[self._token_key(token)] = {
                "user": user,
                "ip": ip,
                "ua": (user_agent or "")[:120],
                "login_ts": now,
                "last_ts": now,
            }
            self._persist.mark_dirty()
            snap = dict(self._sessions)  # R4-1: 锁内快照
        self._persist.flush_if_dirty(snap)
        return token

    def check_session(self, token):
        """Return the session dict for a live token, else None."""
        if not token:
            return None
        key = self._token_key(token)
        now = time.time()
        with self._lock:
            session = self._sessions.get(key)
            if session is None:
                return None
            expired = (
                now - session["last_ts"] > config.SESSION_IDLE_SECS
                or now - session["login_ts"] > config.SESSION_ABSOLUTE_SECS
            )
            if expired:
                del self._sessions[key]
                return None
            session["last_ts"] = now
            self._persist.mark_dirty()
            snap = dict(self._sessions)  # R4-3: fsync 移出认证锁
        self._persist.flush_if_dirty(snap)
        return session

    def revoke_session(self, token):
        with self._lock:
            self._sessions.pop(self._token_key(token), None)
            self._persist.mark_dirty()
            snap = dict(self._sessions)  # R4-1: 锁内快照
        self._persist.flush_if_dirty(snap, force=True)

    @staticmethod
    def _token_key(token):
        return hashlib.sha256(token.encode()).hexdigest()
