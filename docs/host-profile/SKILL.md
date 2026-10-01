---
name: host-profile
description: 需要对确认主机做端口/服务/OS 指纹并识别部署的开源项目(P6 主机全貌)时使用——指纹 100% 覆盖,禁止"待识别"字样
---

# P6 主机全貌:端口/服务/OS/开源项目识别(指纹强制全覆盖)

**铁律:探测出的每个框架/服务必须给指纹;对方是开源项目必须至少确定是哪个
开源项目+版本(能给则给)+依据。交付物里禁止出现"待识别"——识别不出
必须写"指纹源不足"+原因证据(如 403 无正文),且其前置设备(反代/LB)
必须已被识别。所有资产,无例外。**

## 1. 批量指纹管线(统一入口 fp-scan,四层指纹库一条命令)

**目标(用户铁令):只要对面是开源项目,就要直接定位是哪个开源项目(+版本)。
尽一切可能——四层库全过,多库交叉;全部穷尽仍识别不出,才能声明"指纹源不足"。**

```bash
# 默认层(轻,每资产 2-5 请求):httpx 内置 wappalyzer + webappanalyzer(7613)
#   + whatweb(版本最强,默认前 120 资产);自动 follow 重定向拿登录页 title
fp-scan -l assets.txt -o out.tsv # 输出 TSV(-o 显式; 中间文件为 mktemp 私有, 结束即清)
# deep 层(对存疑/高价值资产):追加 nuclei 指纹模板(数量以 fetch-fingerprints 实际交付为准;
#   PD technologies + 0x727 国产库:若依/致远/通达/蓝凌/大华...)
fp-scan -l suspects.txt --deep   # 请求数↑,仅限存疑资产
```
输出列:asset|status|title|server|apps(带版本)|favicon mmh3|source(命中库)。
识别路径优先级:①apps 里直接命中(Ghost:6.64/Flarum/若依式 title)
②title 自报系统名 ③whatweb 字段 ④nuclei deep 命中(shiro-detect→若依类)
⑤特征路径人工兜底(见 §5)。

## 2. 逐资产判定规则

| httpx 结果 | 判定动作 |
|---|---|
| tech 命中(如 Apache:2.4.65) | 直接落账:开源项目+版本+依据"wappalyzer" |
| title 是系统名(如 Coremail邮件系统/若依) | 落账:产品名(商业/开源混合类标明);title 原文为依据 |
| tech 空 + title 空(403/反代拦截) | 取前置指纹(Server: rump/e 等)落账;写"后端指纹源不足:403 无正文(证据:状态码+长度)",禁止留空 |
| 302 登录墙 | `-follow-redirects` 单资产复测一次,拿登录页 title/框架特征 |
| 非 HTTP 端口(25/110/143/...) | banner 即指纹(POP3 +OK Welcome to coremail);nmap -sV 版本 |

## 3. 端口发现(阶梯升级)

```bash
# 第 0 档(零流量):FOFA key 有则 ip="<ip>" 直接拿历史端口
# 第 1 档(极轻):常见 web 端口逐个 HEAD
for p in 80 443 8080 8443 8000 8888 9000 9090 3000 5000; do
  timeout 2 curl -sI http://<ip>:$p -o /dev/null -w "$p %{http_code}\n" 2>/dev/null
done
# 第 2 档(轻扫,单机一次):nmap TCP connect top 端口 + 服务版本
nmap -Pn -sT --top-ports 200 -sV --version-light --open <ip>
# 需要全端口时(升级理由记报告): nmap -Pn -sT -p- --open --min-rate 300 <ip>
```
非 web 高价值端口:21,22,23,3306,5432,6379,7001,7002,8089,9200,11211,27017,3389,1433。
注意:域名侧资产探测与 IP 直探互补——域名经反代/LB,IP 直连可能裸露后端。

## 4. OS 指纹

```bash
nmap -O --osscan-guess <ip>          # 需权限;失败时:
ping -c1 <ip>                        # TTL≈64 Linux/网络设备,≈128 Windows
curl -sI http://<ip>/ | grep -i '^server'   # Server 头佐证
```

## 5. 深挖特征路径(tech/title 都空时的人工兜底)

```bash
curl -s -i --max-time 5 http://<ip>:<port>/ | head -40   # 报错页/框架特征
# 特征路径(单次轻探):
/wp-login.php WordPress | /admin/login RuoYi | /actuator/health Spring Boot
/_next/static Next.js | /login shiro(rememberMe) | /index.action Struts2
/seeyon 致远OA | /tongda 通达OA | /oauth2/login 若依新版
```
不确定写"疑似 X,依据 Y,置信度低"——不装懂,但不许空着。

## 6. 部署矩阵产物格式

```
IP/资产 | OS+依据 | 端口 | 服务/版本 | 开源项目?哪个+版本 | 指纹来源(wappalyzer/title/favicon/banner/特征路径)+依据原文
```
示例:
`202.38.193.28 | Linux(TTL64) | 80,443 | Apache/2.4.65(Unix) | Apache httpd 2.4.65 + 前置苏迪站群 | wappalyzer"Apache HTTP Server:2.4.65,UNIX"+HTML 含 sudy;favicon mmh3=-2837985`
`202.38.251.178(vhost jw) | — | 80,443 | rump/e 反代 | 前置 rump/e;后端指纹源不足:403 无正文 | Server 头原文`

绑定 127.0.0.1 的服务外部探测不到——除非有 SSRF,否则不进资产表。
