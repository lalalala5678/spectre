---
name: host-recon
description: 主机侦察——一键聚合·最小噪声
---

# 主机侦察(线一)
[read-only] 一键聚合优先(单命令多信息),避免高频小命令。

标准聚合(按需裁剪):
`id; uname -a; cat /etc/os-release | head -2; ps aux --sort=-%cpu | head -15;
 ss -tulpn 2>/dev/null | head -20; ip a 2>/dev/null | grep -E "inet |^[0-9]";
 crontab -l 2>/dev/null; ls /etc/cron.d/ 2>/dev/null; sudo -n -l 2>/dev/null;
 cat /proc/net/route | head; env | grep -iE "proxy|aws|aliyun|kube"`

进阶:容器判定(/proc/1/cgroup/.dockerenv)、云元数据(169.254 检测,
仅任务授权时)、凭据位置扫描(~/.ssh/*/config、/opt/*/conf/*)。
产出:主机画像表(身份/系统/服务/网络/凭据位)入情报库。
