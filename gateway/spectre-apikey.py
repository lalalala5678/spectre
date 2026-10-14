#!/usr/bin/env python3
"""spectre-apikey — 网关 API Key 管理 CLI(流量桥等非浏览器客户端入口)。

用法:
  spectre-apikey add <keyid>            # 生成 sk- 前缀密钥, 只打印一次
  spectre-apikey del <keyid>
  spectre-apikey list                   # 仅列 keyid(哈希不出库)
环境: SPECTRE_AUTH_DIR(默认 /etc/spectre-auth; 与 passwd 同目录)
防线: 缺省生产凭据文件已有内容时——tty 交互确认; 非 tty 须显式
      SPECTRE_ALLOW_DEFAULT_AUTH=1(passwd 同款双闸, 且同 R32D83-N1 纪律
      前置于取锁)。

密钥为高熵生成值(非人择口令)——存 sha256 摘要即可(与会话 token 同
口径), 无需 scrypt。客户端用法: 请求头 X-Spectre-Key: sk-...(经网关
换内部令牌直达 runtime /api/*, 无需浏览器会话——Chrome 扩展等跨站
客户端因会话 cookie SameSite=Strict 无法带凭据, 此通道为其设)。
"""
import fcntl  # R32D83-N1 同款: 并发写锁
import hashlib
import os
import secrets
import sys
import tempfile  # 原子写(临时文件+rename)

AUTH_DIR = os.environ.get("SPECTRE_AUTH_DIR", "/etc/spectre-auth")
KEYS = os.path.join(AUTH_DIR, "apikeys")


def read_lines():
    try:
        raw = open(KEYS, encoding="utf-8").read()
        return [line for line in raw.splitlines() if line.strip()]
    except FileNotFoundError:
        return []


def write_lines(lines):
    fd, tmp = tempfile.mkstemp(dir=AUTH_DIR, prefix=".apikeys.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for line in lines:
                handle.write(line + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, KEYS)
        os.chmod(KEYS, 0o600)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def guard_default_dir():
    # 生产双闸(passwd 同款)。注意不引用 PASS——那是 passwd 的密码通道,
    # 本 CLI 无密码概念; 残留引用会让 PASS 环境下静默直写生产(审查废案)。
    # 前置于取锁: 不持排它锁等 tty 输入(R32D83-N1 纪律)。
    if AUTH_DIR == "/etc/spectre-auth" and os.path.exists(KEYS) \
            and os.environ.get("SPECTRE_ALLOW_DEFAULT_AUTH") != "1":
        if not sys.stdin.isatty():
            sys.exit("非 tty 修改生产凭据须 SPECTRE_ALLOW_DEFAULT_AUTH=1")
        if input(f"目标为生产凭据文件 {KEYS}, 继续? [输入 yes] ").strip().lower() != "yes":
            sys.exit("已取消")


def sha256_hex(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def main():
    args = sys.argv[1:]
    # 家族统一(R32D52-N2): -h/--help rc=0; list 单参命令。
    if args in (["-h"], ["--help"]):
        print(__doc__)
        return
    if args == ["list"]:
        for line in read_lines():
            print(line.split(":", 1)[0])
        return
    if len(args) != 2 or args[0] not in ("add", "del"):
        print(__doc__)
        sys.exit(2)
    action, keyid = args
    if not keyid or ":" in keyid or len(keyid) > 64:
        sys.exit("keyid 非法(≤64 字符, 不含冒号)")
    try:
        os.makedirs(AUTH_DIR, exist_ok=True)
    except PermissionError:
        sys.exit(f"无权写 {AUTH_DIR}(sudo 或设 SPECTRE_AUTH_DIR)")
    guard_default_dir()  # 取锁前
    try:
        with open(KEYS + ".lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            lines = read_lines()
            if action == "add":
                if any(line.split(":", 1)[0] == keyid for line in lines):
                    sys.exit(f"keyid 已存在: {keyid}(先 del 或换名)")
                key = "sk-" + secrets.token_urlsafe(32)
                write_lines(lines + [f"{keyid}:{sha256_hex(key)}"])
                print("已生成(只显示这一次, 请立即入密码管理器):")
                print(key)
            else:
                kept = [line for line in lines if line.split(":", 1)[0] != keyid]
                if len(kept) == len(lines):
                    sys.exit(f"keyid 不存在: {keyid}")
                write_lines(kept)
                print(f"已删除: {keyid}")
    except PermissionError:
        sys.exit(f"无权写 {KEYS}(sudo 或设 SPECTRE_AUTH_DIR)")


if __name__ == "__main__":
    main()
