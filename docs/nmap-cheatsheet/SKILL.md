---
name: nmap-cheatsheet
description: 需要 nmap 扫描参数速查时使用
---

# nmap-cheatsheet

nmap 扫描参数速查:端口扫描 / 服务识别 / 脚本扫描 三段速查。

## 1. 端口扫描

| 参数 | 说明 |
|---|---|
| `-sS` | TCP SYN 半开扫描(快、隐蔽,需 root) |
| `-sT` | TCP 全连接扫描(无需特权,易留日志) |
| `-sU` | UDP 扫描(慢,建议配 --top-ports 限定) |
| `-sA` | ACK 扫描,探测防火墙规则 |
| `-p 80,443,8080` | 指定端口列表 |
| `-p 1-1000` | 指定端口范围 |
| `-p-` | 全端口 1-65535 |
| `--top-ports 100` | 扫描最常见 100 端口 |
| `-T0~T5` | 时序模板,默认 -T3;-T4 快;-T0/-T1 极慢用于绕 IDS |
| `-Pn` | 跳过主机发现直接扫(目标禁 ping 时必加) |
| `-sn` | 仅主机存活探测,不扫端口 |

常用组合:

```bash
nmap -sS -Pn -T4 --top-ports 100 <target>   # 快速常规扫
nmap -sS -sU -Pn --top-ports 100 <target>   # TCP+UDP
nmap -sS -Pn -T4 -p- <target>               # TCP 全端口
```

## 2. 服务识别

| 参数 | 说明 |
|---|---|
| `-sV` | 探测端口上服务/版本 |
| `--version-intensity 0-9` | 版本探测强度,默认 7,0 最轻量 |
| `--version-all` | 等价强度 9 |
| `-O` | 操作系统识别(需 root) |
| `-A` | 聚合探测:OS + 版本 + 默认脚本 + traceroute |

常用组合:

```bash
nmap -sV -Pn -p 22,80,443 <target>        # 只对已发现端口做版本识别
nmap -sV -sC -O -Pn -p <ports> <target>   # 深度:版本+脚本+OS
```

## 3. 脚本扫描

| 参数 | 说明 |
|---|---|
| `-sC` | 默认脚本集(等价 --script=default) |
| `--script=<名称/分类>` | 指定脚本或分类 |
| `--script-args 'k=v'` | 传脚本参数 |

常用分类:vuln(漏洞)、auth(未授权/弱配置)、brute(爆破)、discovery(枚举)、safe。

```bash
nmap --script=vuln -Pn <target>                          # 漏洞类脚本
nmap -sC -sV -Pn -p <ports> <target>                     # 默认脚本+版本
nmap --script=http-enum,http-title,http-server-header -p 80,443 <target>   # Web 枚举
nmap --script=mysql-brute -p 3306 <target>               # 数据库弱口令示例
nmap --script-updatedb                                   # 更新脚本库
```

## 备注

- 大多数 SYN/-O 类参数需 root 权限。
- 扫描前确认授权范围,仅对授权目标使用。