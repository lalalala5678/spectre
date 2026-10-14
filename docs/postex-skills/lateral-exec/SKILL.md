---
name: lateral-exec
description: 横向移动执行——impacket 选型/凭据传递/新通道登记(承接 lateral-prep 的候选清单)
---

# 横向移动执行(postex 线四执行层)

[runs commands; side-effects] 输入: lateral-prep 的横向候选清单(网段/凭据
复用面/跳板价值)或任务指令直接给出。本技能补上 lateral-prep 明确不做
的"动"的那一半——落到执行。

## 选型表(按噪声从低到高)

| 工具 | 通道 | 落盘 | 适用 |
|---|---|---|---|
| wmiexec.py | 135/WMI | 无(经 WMI 创建进程) | 首选; 目标开放 DCOM |
| smbexec.py | 445/命名管道 | 无( svc 随用随删) | WMI 被封时的 445 替代 |
| atexec.py | 445/计划任务 | 任务文件(自清) | 旧系统(Win2003/XP 调度器) |
| psexec.py | 445/服务 | 落盘服务程序 | 最后手段(服务安装高噪, ER 高危特征) |

## 前置(缺一不发起)

1. 凭据: query_intel 拉 weakcred/postex 产出的账密或 NTLM hash
   (hash 走 `-hashes :NT`——明文与 hash 同权, 优先用已验证活的);
2. 可达性: 候选主机的 445/135 实测开(地图来自 lateral-prep, 逾期的
   重测单点再打——网段拓扑会变);
3. 凭据失效即停: 一次认证失败换下一台, 同一台不超 2 次(锁定面保护)。

## 执行纪律

- 每台命中后: `hostname && whoami` 留证 → report_vulnerability(横向
  面命中按系统级别定级) + publish_intel(新主机/新凭据面, 供后续席位);
- 拿到的新会话**必须 register 进 shell 通道体系**(ssh/beacon 按形态),
  后续操作经 shell 工具——禁 bash 裸跑绕审计(编排器铁则 5 同源);
- 执行产生的工件(上传的 exe/脚本)记入台账, 收尾按 trace-cleanup 清理。

## 停止条件

- 候选清单穷尽或凭据全失效 → 如实报"清单尽/凭据死", 未打到的主机
  列入未竟项(blocked_by=credential);
- 出现 EDR 告警迹象(进程秒被杀/账户被禁) → 该主机止损, 台账记录。

## 证据要求

hostname/whoami/ipconfig 回执原文; 认证失败的目标逐台列失败形态
(超时/凭据拒/锁定)——阴性结论也是交付物。
