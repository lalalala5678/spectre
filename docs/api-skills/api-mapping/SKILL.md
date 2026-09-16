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
