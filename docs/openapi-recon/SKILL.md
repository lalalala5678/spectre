---
name: openapi-recon
description: 从 openapi/swagger 生成测试路径+用例(kiterunner 借鉴)
---

# openapi-paths(kiterunner 借鉴)
[read-only] 上下文感知:从 API 文档生成候选路径,比盲扫快 10 倍。

## 用法
```bash
openapi-paths.py --spec http://target/openapi.json [--base /api] [--json]
openapi-paths.py --file local-spec.json
```

## 输出
1. 全部路径(method+认证标记+参数)
2. 猜测的隐藏兄弟路径(/{id}/detail/export/admin/all/list/search)
3. 测试用例:
   - idor: {id} 参数端点→替换其他用户 ID
   - mass-assignment: POST/PUT→注入 role/is_admin/status/balance
   - unauth-sensitive: 无 security 标记的敏感端点(user/admin/internal/debug/config/secret)

## 优先级
openapi.json/swagger.json/v2/api-docs → 有文档先走文档路径,没有再 arjun/dirsearch 盲扫。
