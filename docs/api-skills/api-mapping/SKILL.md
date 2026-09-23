---
name: api-mapping
description: 接口测绘(线一武器化)
---

# 接口测绘(线一武器化)
[read-only 侦察+轻探测] 目标:还原目标全部 API 端点×参数×鉴权头。

## 入口优先级(命中率排序)
1. 前端 JS chunk:webpack 按路由分块(如 studentManagement-CrgtAaQo.js)。
   `grep -oE "(api|/v[0-9])/[a-zA-Z0-9/_{}-]+" *.js | sort -u` 路径;
   再抓参数名(filter/real_name/department_name 等业务词)与枚举值。
2. OpenAPI 暴露:/swagger /swagger-ui /v2/api-docs /v3/api-docs /openapi.json
   /.well-known/openapi /doc.html(drapper)。
3. 小程序/H5:wxapkg 解包(wxappUnpacker)→app.js/api 目录。
4. 结构模板爆破(kiterunner 思路):
   /api/{v1,v2,api}/{user,users,order,orders,admin,list,search,export,report}
   /{N} 子资源两级;ffuf -w 模板词表,校准 404 基线(软 404:全路径 200+等长)。
5. 历史面:gau/waybackurls 域名→grep api。

## 隐藏参数挖掘(Arjun 法,已装 /opt/tools/py)
`PYTHONPATH=/opt/tools/py arjun -u URL -m GET` 响应差分三通道:状态码/长度/
延时。手工版:对照组发 debug=1/admin=true/internal=1/callback=URL/
page_size=9999,任一通道跳变即登记。

## 登记表格式(下游鉴权矩阵的输入)
| 端点 | 方法 | 参数 | 鉴权头 | 响应结构 | 敏感字段 |
每端点一行,完结后 publish_intel 交回(标记 api-surface)。

## 6. 路径模板空间完整性(2026-09 apibench 三轮 0/4 教训,通用)
名词×动词矩阵不够。模板空间必须含:
1. **连接符变体**:操作词复合时 {无连,连字符-,下划线_,斜杠/} 四态全试:
   search-list/searchlist/search_list/search/list——450 发名词矩阵可被
   一个连字符全灭,连接符维度优先级高于名词广度
2. **资源锚定模式**(已知模块 user/order/profile/news 时,比盲猜名词高产):
   - /api/<资源>/public/<标识>   (公开档案位)
   - /api/admin/<资源>/<id>/<动词> (管理动作位:reset-password/approve/delete)
   - /api/<资源>/search-list|list|page (列表导出位)
   - /api/<动词>-<资源> 反序复合 (reset-password 型)
3. **单复数×层级**:user/users×1-2 级子资源先行,再扩名词广度
4. 排除域入账:负空间结果连同模板形状记录,二次扫描只换连接符/层级不重跑名词

## 7. 会话起步协议(apibench 净跑 64 发实证)
1. query_intel 拉历史档案与负空间(平台记忆=合法资产,先查再打)
2. 目标若重置:立即 publish 地面真值快照(种子数/ID 段/令牌方案有效性)
3. 预算执行体:source /opt/tools/bin/httpq.sh(httpq <label> <curl...>
   一发一账;HTTPQ_BUDGET 控制,超发自动拒)
4. 工具:/opt/tools/bin/{toklab.py,jsondiff.py,authmatrix.py}
   (令牌工位/响应差分/鉴权矩阵——见各技能)
