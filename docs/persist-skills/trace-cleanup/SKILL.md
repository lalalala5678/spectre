---
name: trace-cleanup
description: 痕迹清理与反取证——零残留证明
---

# 痕迹清理
[side-effects] 目标主机操作痕迹清理;平台 bus 审计是证据链永不动。

## 清单
- shell 历史:history -c;unset HISTFILE;清理 ~/.bash_history 等价物
- 登录痕迹:wtmp/btmp/lastlog(谨慎,时间戳一致性)
- 部署残留:维持件相关临时文件/下载缓存/工具副本(find 复核)
- 时间戳恢复:touch -r 参照系统文件(伪装令⑨)
- 日志:应用日志中本会话特征行(仅删除本会话产生的行,不破坏日志连续性)

## 零残留证明(必交)
清理后复核命令输出(find/grep 目标特征词零命中)+清理前后对比,
入 publish_intel 台账。清理不彻底=任务失败(第一性原则)。
