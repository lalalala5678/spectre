---
name: infra-analysis
description: Web 基础设施分析(P4 拓扑+P5 CDN)——前后端分离/API 真实后端/CDN 判定与源站定位, 数据源重叠(CNAME/DNS/IP)一次采集两面分析
---

# Web 基础设施分析: P4 拓扑 + P5 CDN 判定与绕过

CNAME/DNS/IP 数据源重叠——**一次采集, 两面分析**: dig/CNAME/证书/JS 抓取
一遍做完, P4 拓扑边与 P5 CDN 结论共用回执。
目标: 每条 Web 资产回答——前端/后端在哪台机器、API 连通哪些第三方、
是否 CDN、哪家、源站 IP(若可得)+ 绕过路径证据; 每条结论带证据。

## P4 拓扑

### 1. 前端 JS 静态分析(主要手段, 轻)

```bash
# 收首页与入口页, 提取 JS 资源
curl -s https://<site> -o /tmp/idx.html
grep -oE '(src|href)="[^"]+\.js[^"]*"' /tmp/idx.html | cut -d'"' -f2

# 下载每个 JS, grep API 地址与内部域名(chunk 文件常含 baseURL/apiHost 配置——全部过一遍)
curl -s <js-url> | grep -oE 'https?://[a-zA-Z0-9.-]+\.[a-z]{2,}[^"'"'"' )]*' | sort -u
curl -s <js-url> | grep -oE '"/(api|v1|v2|gw|gateway)/[^"]+"' | sort -u
```

### 2. 前后端分离判定信号

| 信号 | 判定 |
|---|---|
| 静态 SPA(入口 html 仅引 JS)+ JS 里有独立 API 域名/IP | 前后端分离, 前端机=静态资源机, 后端机=API 域解析 IP |
| 同域路径 /api/* 返 JSON 且 Server 头与静态不同 | 同机反代或同机部署, 记录两段 Server 头差异 |
| CORS 头 Access-Control-Allow-Origin 指向别的域 | 该域是前端源, 当前域是纯 API 后端 |

```bash
curl -sI https://<site>/api/ | grep -iE "server|x-powered|access-control"
curl -s -X OPTIONS -i https://<site>/api/ -H "Origin: https://test.local" | grep -i access-control
```

### 3. API 后端定位与第三方连通

- JS 里发现的每个 API 域名: 单独 dig 解析 → 后端 IP 集合
- JS 里的第三方服务(Sentry/统计/对象存储/内部服务地址)也记录: 攻击面的一部分
- API 根路径轻探(确认存活与技术栈, 不深挖接口逻辑——那是 api agent 的活):
```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://<api-host>/
curl -s https://<api-host>/ | head -c 400   # 看报错页框架特征
```

### 4. 拓扑边产物格式

```
前端资产 | 后端资产 | 关系类型(api-base/反代/同机) | 证据(JS 文件名+行内原文/CORS 头原文)
site.web (1.2.3.4) | api.target.cn (5.6.7.8) | api-base | app.js: "baseURL:'https://api.target.cn'"
```
每条边的前端 IP 与后端 IP 都必须来自实际解析回执, 不许从文档/猜想填。

## P5 CDN 判定与绕过

绕不过也必须识别出来; **把非 CDN 误判为 CDN 是严重错误**(会漏掉直接打的
源站)。

### 1. CDN 判定(全被动)

```bash
dig +short <domain>          # 多 A 记录散布(≥4 个不同 IP)→ 疑似 CDN
dig <domain> CNAME +short    # CNAME 链是铁证
```

| CNAME 特征 | CDN |
|---|---|
| *.cloudflare.com / *.cdn.cloudflare.net | Cloudflare |
| *.kunlun*.com / *.alikunlun.com / *.wscdn | 阿里云 CDN |
| cdn.dnsv1.com / *.cdn.dnsv1.com / tcdn.qq.com | 腾讯云 CDN |
| *.qiniudns.com / *.qbox.me | 七牛 |
| *.wscdns.com / *.wscloudcdn.com | 网宿 |
| *.cdngc.net / *.ourwebpic.com | 白山/其它, 查 whois 确认 |

辅助: IP 段 whois(org=Cloudflare/阿里云计算)佐证。注意: **单 IP + 无 CNAME
+ whois 归目标自有机房 = 不是 CDN**, 直连源站, 别误标。

### 2. 源站定位(免费路径优先, 逐条尝试并记录)

- **旁路子域**(命中率最高): 内部/运维子域常不套 CDN——
  `for sub in mail ftp cpanel webmail admin api dev test vpn oa erp git jenkins zabbix; do dig +short $sub.<root> | grep -E '^[0-9.]+$'; done`; 得到的 IP 用 §3 验证
- **证书维度**: `curl -s "https://crt.sh/?q=%25.<root>&output=json" | jq -r '.[].name_value' | sort -u`(SAN 常暴露内部命名)
- **历史 DNS / 被动 DNS**: 免 key 用 Bing——`fetch_url "https://www.bing.com/search?q=<domain>+ip+history"`
- **邮件头**(若能触发目标发信, 如找回密码邮件): Received 链最早一跳 = 源站内网出口 IP

### 3. 源站验证(证明不是巧合)

```bash
# 用候选 IP + 正确 Host 头直连, 内容与 CDN 版本一致 = 真源站
curl -s -H "Host: <domain>" http://<candidate-ip>/ -o /tmp/a.html
curl -s https://<domain>/ -o /tmp/b.html
diff <(head -c 2000 /tmp/a.html) <(head -c 2000 /tmp/b.html) && echo "ORIGIN CONFIRMED"
```
标题/关键路径(如 favicon hash)一致即可判定。

### 4. CDN 产物格式

```
资产 | CDN?(是/否) | CDN厂商+证据(CNAME原文) | 源站IP | 绕过路径(旁路子域名/证书/历史DNS) | 验证回执摘要
```
