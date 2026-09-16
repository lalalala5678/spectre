---
name: auth-matrix
description: 鉴权矩阵(线二武器化·核心武器)
---

# 鉴权矩阵(线二武器化·核心武器)
[轻探测] 目标:对测绘登记的每个敏感端点证明/排除鉴权缺陷。

## N×M 重放协议
身份 N(至少 3):未登录 / 用户 A / 用户 B(或 admin 若有)。
动作 M:端点允许的全部方法。每格 1 发,≤12 发/面。
工具:python requests 双 session 脚本(平台模板 authmatrix.py 思路)。

## 判定四态(每态都要对照组差分,不许单响应定案)
- 漏鉴权:未登录 200+业务数据;对照:同站已知需鉴权接口返回 401/110002
  (xlzx 实战:/api/auth/me 110002 vs /api/user/search-list 200——中间件遗漏)
- BOLA(水平):A 的 token 读 B 的对象(200+B 的数据=中;可推 ID=高)
- BFLA(垂直):普通用户 token 调 admin 端点(200+执行=高)
- PPOR(属性级):响应含越权字段(is_admin/password_hash/salary/sfzh)

## GraphQL 专项
introspection 查询→__schema 全字段→逐字段×两身份重放(字段级授权差异);
mutation 全枚举×身份矩阵;alias/batch 证明 1 发即停。

## JWT 面快速检查
alg:none/HS256-RS256 混淆(kid injection 单发试)/exp 不校验/用户对象引用
(sub 改 B 重放)。工具 /opt/tools/jwt_tool(PYTHONPATH=/opt/tools/py)。

## 证据形态(落账标准)
对照组请求对原文(2 发)+最小化样本(2-3 条数据)+可推性数学论证。
缺对照=不落账。批量可推性论证模板:格式规律+总量+顺序证据。
