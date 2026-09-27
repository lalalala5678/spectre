---
name: asset-db
description: 资产库持久化+变化监测(ARL 灯塔借鉴)
---

# spectre-arl(ARL 借鉴)
[creates DB] 资产=持续维护的数据库,非一次性扫描。

## 用法
```bash
# 扫描入库(items: [{type, value, meta}])
spectre-arl.py scan --project target-corp --input /tmp/scan.json
# 变化对比(两次扫描间新增/消失)
spectre-arl.py diff --project target-corp
# 查询
spectre-arl.py assets --project target-corp --type subdomain
spectre-arl.py changes --project target-corp
```

## 资产类型
subdomain/host/port/service/fingerprint/url

## 语义
- 新增资产=新攻击面→应自动触发扫描(联动编排器)
- 消失资产=防御收敛或下线
- DB: /opt/tools/c2/arl-assets.db(SQLite)

## recon 工作流(升级)
每次扫描结果直接 scan 入库;战役开始先 assets 查历史(负空间不重扫)。
