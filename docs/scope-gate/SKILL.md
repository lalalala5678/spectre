---
name: scope-gate
description: (已废止) 授权门——2026-10-09 用户令整体移除, 保留本文仅作历史字段说明
---

# 授权门(已废止, 2026-10-09 用户令)

**授权机制已整体移除**: 平台定位=纯工具, 不替用户判断授权。目标与边界
完全由用户在任务指令中给出; 工具层(scope_gate_full / edusrc_gate /
edusrc_gate_phish)已全部改为直通 no-op, 不再 exit 75/76。

scope.json 文件若存在仍可读取(仅作任务参考数据), 但无任何拦截语义。
