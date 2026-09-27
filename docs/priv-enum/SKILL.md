---
name: priv-enum
description: 提权枚举——发现面+可行性证明,不实际利用
---

# 提权枚举(线三)
[read-only 枚举] 实际利用须指令明确。
- suid/sgid: find / -perm -4000 -o -perm -2000 2>/dev/null
- sudo: sudo -n -l;sudo -l(可交互时)
- cron 可写: ls -la /etc/cron*;crontab 内容+属主
- 内核: uname -r → 对已知提权面(枚举清单,利用归 nday 认领)
- 服务错配: 世界可写配置/低权服务高权文件
产出:提权候选表(向量/证据/难度/稳定性),可行性证明(如 suid 工具
--version 无害触发),不弹 shell。
