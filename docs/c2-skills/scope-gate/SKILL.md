---
name: scope-gate
description: 授权门——目标清单+时间窗+审计,越界拒
---

# 授权门(硬纪律)
[read-only check] 一切载荷生成/检测/交付的前置条件。

1. 读 /opt/tools/c2/scope.json:targets 空=全拒;目标不在清单=拒;
   当前时间出窗=拒(载荷过期自废逻辑同源)
2. 审计日志 /opt/tools/c2/audit.log 追加:时间/目标/动作/载荷哈希/
   引擎结果摘要
3. EDUSRC 硬隔离:教育 SRC 相关工作区出现任何本 agent 载荷需求=拒+说明
4. 窗口结束:交付包标记 EXPIRED,变体引擎停用
