---
name: persist-methods
description: 隐蔽权限维持方法库(Linux/Java/Windows)——部署·验证·清理三件套
---

# 权限维持方法库
[target ops] 全部经 shell 工具执行;三令继承(伪装/授权门/审计)。

## Linux
- cron:伪装系统维护名(/etc/cron.d/sys-maint-sync 型);内容指向伪装路径
- systemd timer:拟系统服务名(sys-update-notifier);OnCalendar 低频
- SSH authorized_keys:密钥注释拟运维(contact@ops);chkconfig 权限 600
- sudoers.d 规则:低可见;配合 NOPASSWD 特定命令
- ld.so preload:极隐蔽但破坏风险高,仅任务明确要求
## Java 应用内
- 与 c2 协商:注入位驻留(Filter/Listener 重注入),c2 侧协议兼容
- 应用重启存活:结合启动脚本/外部 cron 拉活
## Windows(可达时)
- 计划任务(schtasks 拟更新任务)/服务/注册表 Run 键

## 三件套纪律(每项)
1. 部署:伪装名+伪装内容+时间戳拟态(touch -r 参照文件)
2. 独立验证:重新进入成功证明(cron 日志/重连成功/key 登录)
3. 清理步骤登记(逆向操作清单,窗口结束执行)
选型三轴:重启存活×隐蔽性×清理复杂度,打分留备选。
