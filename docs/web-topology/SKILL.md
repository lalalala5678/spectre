---
name: web-topology
description: 需要确认 Web 资产的内部结构(P4 拓扑:前后端分离、API 真实后端 IP、前端机与后端机映射)时使用
---

# P4 Web 拓扑确认

目标:对每个 Web 资产回答——前端在哪台机器、后端 API 在哪台机器、
API 接口还连通哪些第三方 IP、背后的服务器是什么。每条拓扑边带证据。

## 1. 前端 JS 静态分析(主要手段,轻)

```bash
# 收首页与入口页,提取 JS 资源
curl -s https://<site> -o /tmp/idx.html
grep -oE '(src|href)="[^"]+\.js[^"]*"' /tmp/idx.html | cut -d'"' -f2

# 下载每个 JS,grep API 地址与内部域名
curl -s <js-url> | grep -oE 'https?://[a-zA-Z0-9.-]+\.[a-z]{2,}[^"'"'"' )]*' | sort -u
curl -s <js-url> | grep -oE '"/(api|v1|v2|gw|gateway)/[^"]+"' | sort -u
# chunk 文件(app.abc123.js)常含 baseURL/apiHost 配置——全部过一遍
```

## 2. 前后端分离判定信号

| 信号 | 判定 |
|---|---|
| 静态 SPA(入口 html 仅引 JS)+ JS 里有独立 API 域名/IP | 前后端分离,前端机=静态资源机,后端机=API 域解析 IP |
| 同域路径 /api/* 返 JSON 且 Server 头与静态不同 | 同机反代或同机部署,记录两段 Server 头差异 |
| CORS 头 Access-Control-Allow-Origin 指向别的域 | 该域是前端源,当前域是纯 API 后端 |

```bash
curl -sI https://<site>/api/ | grep -iE "server|x-powered|access-control"
curl -s -X OPTIONS -i https://<site>/api/ -H "Origin: https://test.local" | grep -i access-control
```

## 3. API 后端定位与第三方连通

- JS 里发现的每个 API 域名:单独 dig 解析 → 后端 IP 集合
- JS 里的第三方服务(Sentry/统计/对象存储/内部服务地址)也记录:它们是攻击面的一部分
- API 根路径轻探(确认存活与技术栈,不深挖接口逻辑——那是 api agent 的活):
```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://<api-host>/
curl -s https://<api-host>/ | head -c 400   # 看报错页框架特征
```

## 4. 拓扑边产物格式

```
前端资产 | 后端资产 | 关系类型(api-base/反代/同机) | 证据(JS 文件名+行内原文/CORS 头原文)
site.web (1.2.3.4) | api.target.cn (5.6.7.8) | api-base | app.js: "baseURL:'https://api.target.cn'"
```

每条边的前端 IP 与后端 IP 都必须来自实际解析回执,不许从文档/猜想填。
