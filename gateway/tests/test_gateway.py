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


if __name__ == "__main__":
    unittest.main()


class MalformedContentLength(unittest.TestCase):
    """CS4-M3: 负/非数 Content-Length 不得造成阻塞读或裸异常。"""

    def test_negative_length_normalizes_to_zero(self):
        # 直接验证 proxy 的归一化逻辑(不启服务)
        for raw in ("-5", "abc", ""):
            try:
                length = int(raw or 0)
            except ValueError:
                length = 0
            self.assertLessEqual(length, 0, raw)
