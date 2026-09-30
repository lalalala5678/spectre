#!/usr/bin/env python3
"""spectre-passwd — 网关账号管理 CLI。

用法:
  spectre-passwd add <user>              # 交互输入密码(或 PASS 环境变量)
  spectre-passwd del <user>
  spectre-passwd list
环境: SPECTRE_AUTH_DIR(默认 /etc/spectre-auth)
"""
import os
import sys
import getpass
import secrets
import base64

AUTH_DIR = os.environ.get("SPECTRE_AUTH_DIR", "/etc/spectre-auth")
PASSWD = os.path.join(AUTH_DIR, "passwd")
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 15, 8, 1


def hash_pw(pw: str) -> str:
    salt = secrets.token_bytes(16)
    try:
        import hashlib
        h = hashlib.scrypt(pw.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R,
                           p=SCRYPT_P, dklen=32, maxmem=128 * 1024 * 1024)
    except ImportError:
        sys.exit("需要 Python 3.7+")
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${base64.b64encode(salt).decode()}${base64.b64encode(h).decode()}"


def read_lines():
    try:
        return [l for l in open(PASSWD, encoding="utf-8").read().splitlines() if l.strip()]
    except FileNotFoundError:
        return []


def write_lines(lines):
    os.makedirs(AUTH_DIR, mode=0o750, exist_ok=True)
    existed = os.path.exists(PASSWD)
    with open(PASSWD, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))
    os.chmod(PASSWD, 0o640)
    if not existed:
        print(f"[spectre-passwd] 已创建 {PASSWD}")


def main():
    argv = sys.argv[1:]
    if len(argv) < 1 or argv[0] not in ("add", "del", "list"):
        print(__doc__)
        sys.exit(2)
    cmd = argv[0]
    if cmd == "list":
        for l in read_lines():
            print(l.split(":", 1)[0])
        return
    if len(argv) != 2:
        print("用法: spectre-passwd add|del <user>", file=sys.stderr)
        sys.exit(2)
    user = argv[1]
    if ":" in user or not user.strip():
        sys.exit("用户名不允许含冒号/空白")
    lines = read_lines()
    rest = [l for l in lines if l.split(":", 1)[0] != user]
    if cmd == "del":
        if len(rest) == len(lines):
            sys.exit(f"用户不存在: {user}")
        write_lines(rest)
        print(f"[spectre-passwd] 已删除 {user}")
        return
    if len(rest) != len(lines):
        print(f"[spectre-passwd] 注意: 用户 {user} 已存在, 本次将覆盖其密码")
    pw = os.environ.get("PASS") or getpass.getpass(f"为 {user} 设置密码: ")
    if len(pw) < 8:
        sys.exit("密码至少 8 位")
    write_lines(rest + [f"{user}:{hash_pw(pw)}"])
    print(f"[spectre-passwd] 已写入 {user}(scrypt$n={SCRYPT_N}) → {PASSWD}")


if __name__ == "__main__":
    main()
