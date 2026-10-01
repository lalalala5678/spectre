"""gateway 回归测试(stdlib unittest, 零第三方依赖)。

R32D33 P0 建议: N1/N2 两个运行时回归(PEP8 重构引入)此前无任何机器防线。
运行: python3 -m unittest discover -s gateway/tests -v
"""
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from spectre_gateway import security  # noqa: E402

PASSWD = os.path.join(os.path.dirname(__file__), "..", "spectre-passwd.py")


class PasswdCliRoundTrip(unittest.TestCase):
    """N1: l→line 重命名曾让 list/del 全 NameError。"""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pw-test-")
        self.env = {**os.environ, "SPECTRE_AUTH_DIR": self.dir,
                    "PASS": "TestPass1234"}

    def _run(self, *args):
        return subprocess.run(
            [sys.executable, PASSWD, *args],
            env=self.env, capture_output=True, text=True, timeout=30)

    def test_add_list_del_roundtrip(self):
        r1 = self._run("add", "alice")
        self.assertEqual(r1.returncode, 0, r1.stderr)
        r2 = self._run("add", "bob")
        self.assertEqual(r2.returncode, 0, r2.stderr)
        r3 = self._run("list")
        self.assertEqual(r3.returncode, 0, r3.stderr)
        self.assertIn("alice", r3.stdout)
        self.assertIn("bob", r3.stdout)
        r4 = self._run("del", "alice")
        self.assertEqual(r4.returncode, 0, r4.stderr)
        r5 = self._run("list")
        self.assertNotIn("alice", r5.stdout)
        self.assertIn("bob", r5.stdout)


class LockoutStateMachine(unittest.TestCase):
    """N2: record_failure 守卫重排曾让首次失败炸线程(state=None 取键)。"""

    def test_first_failure_then_lockout(self):
        sec = security.Security()
        locked = sec.record_failure("9.9.9.9")
        self.assertFalse(locked)  # 首次失败: 不炸、不锁
        for _ in range(3):
            locked = sec.record_failure("9.9.9.9")
        self.assertFalse(locked)  # 第 4 次
        locked = sec.record_failure("9.9.9.9")
        self.assertTrue(locked)   # 第 5 次锁定
        self.assertTrue(sec.is_locked("9.9.9.9"))
        self.assertFalse(sec.is_locked("8.8.8.8"))  # 互不影响

    def test_window_rollover_resets(self):
        sec = security.Security()
        for _ in range(5):
            sec.record_failure("7.7.7.7")
        # 窗口已过(直接拨状态, 不 sleep)
        with sec._lock:
            sec._failtrack["7.7.7.7"]["window_start"] = 0
        locked = sec.record_failure("7.7.7.7")
        self.assertFalse(locked)  # 过期重开窗口, 计数归零


class NormalizeContentLength(unittest.TestCase):
    """CS4-M3/CS5-N3: 真防线——import proxy.normalize_content_length。"""

    def test_malformed_values_normalize_to_zero(self):
        from spectre_gateway.proxy import normalize_content_length
        for raw in ("-5", "abc", "", None, "0"):
            self.assertEqual(normalize_content_length(raw), 0, raw)

    def test_positive_passthrough(self):
        from spectre_gateway.proxy import normalize_content_length
        self.assertEqual(normalize_content_length("128"), 128)


class ProxyMalformedCL(unittest.TestCase):
    """R32D38-NEW-7: 有声明但 CL<=0 的 /api 转发前 413 断连."""

    def test_negative_cl_rejected_before_upstream(self):
        from unittest.mock import MagicMock
        from spectre_gateway import proxy

        handler = MagicMock()
        handler.headers = {"Content-Length": "-3"}

        class _Blocked:
            def __init__(self, *a, **k):
                pass

            def request(self, *a, **k):
                raise AssertionError("must not reach upstream")

        orig = proxy.http.client.HTTPConnection
        proxy.http.client.HTTPConnection = _Blocked
        try:
            proxy.proxy(handler, "/api/projects")
            self.assertEqual(handler._send.call_args[0][0], 413)
            self.assertTrue(handler.close_connection)
        finally:
            proxy.http.client.HTTPConnection = orig


if __name__ == "__main__":
    unittest.main()
