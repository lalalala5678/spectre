#!/usr/bin/env python3
"""spectre-passwd — 网关账号管理 CLI。

用法:
  spectre-passwd add <user>              # 交互输入密码(或 PASS 环境变量)
  spectre-passwd del <user>
  spectre-passwd list
环境: SPECTRE_AUTH_DIR(默认 /etc/spectre-auth)
防线: 缺省生产凭据文件已有内容时——tty 交互确认; 非 tty 必须显式
      SPECTRE_ALLOW_DEFAULT_AUTH=1 放行(管道/脚本误写生产防线)。
"""
import base64
import getpass
import hashlib  # CS1-E1: 此前 __import__() 动态导入(PEP 8 禁项), 无任何动态理由
import os
import secrets
import sys

AUTH_DIR = os.environ.get("SPECTRE_AUTH_DIR", "/etc/spectre-auth")
PASSWD = os.path.join(AUTH_DIR, "passwd")
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 15, 8, 1


def hash_pw(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=SCRYPT_N,
                       r=SCRYPT_R, p=SCRYPT_P, dklen=32,
                       maxmem=128 * 1024 * 1024)
    b64salt = base64.b64encode(salt).decode()
    b64hash = base64.b64encode(h).decode()
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${b64salt}${b64hash}"


def read_lines():
    try:
        raw = open(PASSWD, encoding="utf-8").read()
        return [line for line in raw.splitlines() if line.strip()]
    except FileNotFoundError:
        return []


def _write_guard():
    # D3(十轮): 非 root 对系统路径 PermissionError 裸栈→友好指引
    try:
        os.makedirs(AUTH_DIR, mode=0o750, exist_ok=True)
        probe = os.path.join(AUTH_DIR, ".probe")
        with open(probe, "w") as f:
            f.write("x")
        os.unlink(probe)
    except PermissionError:
        sys.exit(f"[spectre-passwd] 无权写入 {AUTH_DIR} — 用 sudo, "
                 f"或设 SPECTRE_AUTH_DIR 指向可写目录")


def write_lines(lines):
    if os.path.exists(PASSWD) and not os.environ.get("SPECTRE_AUTH_DIR"):
        # D1+F2(十/十六轮): 缺省生产凭据已有内容——防误写双闸。
        print(f"[spectre-passwd] 注意: 即将修改缺省凭据文件 "
              f"{PASSWD}(既有装机账号将受影响)", file=sys.stderr)
        if os.environ.get("SPECTRE_ALLOW_DEFAULT_AUTH") != "1":
            if not sys.stdin.isatty():
                print("[spectre-passwd] 拒绝: 非 tty 修改缺省生产凭据"
                      "——设 SPECTRE_ALLOW_DEFAULT_AUTH=1 显式放行, "
                      "或 SPECTRE_AUTH_DIR 隔离", file=sys.stderr)
                sys.exit(1)
            try:
                ans = input("[spectre-passwd] 确认继续? [y/N] ").strip().lower()
            except EOFError:
                ans = ""
            if ans != "y":
                print("[spectre-passwd] 已取消(SPECTRE_AUTH_DIR 隔离 / "
                      "SPECTRE_ALLOW_DEFAULT_AUTH=1 跳过)", file=sys.stderr)
                sys.exit(1)
    _write_guard()
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
        for line in read_lines():
            print(line.split(":", 1)[0])
        return
    if len(argv) != 2:
        print("用法: spectre-passwd add|del <user>", file=sys.stderr)
        sys.exit(2)
    user = argv[1]
    if ":" in user or not user.strip():
        sys.exit("用户名不允许含冒号/空白")
    lines = read_lines()
    rest = [line for line in lines if line.split(":", 1)[0] != user]
    if cmd == "del":
        if len(rest) == len(lines):
            sys.exit(f"用户不存在: {user}")
        write_lines(rest)
        print(f"[spectre-passwd] 已删除 {user}")
        return
    if len(rest) != len(lines):
        print(f"[spectre-passwd] 注意: 用户 {user} 已存在, 本次将覆盖其密码")
    pw = os.environ.get("PASS")
    if not pw:
        if not sys.stdin.isatty():
            sys.exit("[spectre-passwd] 非 tty 且未设 PASS 环境变量 — "
                     "PASS='<密码>' python3 spectre-passwd.py add <user>")
        pw = getpass.getpass(f"为 {user} 设置密码: ")
    if len(pw) < 8:
        sys.exit("密码至少 8 位")
    write_lines(rest + [f"{user}:{hash_pw(pw)}"])
    print(f"[spectre-passwd] 已写入 {user}(scrypt$n={SCRYPT_N}) → {PASSWD}")


if __name__ == "__main__":
    main()
