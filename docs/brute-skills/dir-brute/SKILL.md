---
name: dir-brute
description: 需要对 Web 资产做目录/路径/备份文件/后台入口爆破(ffuf/dirsearch+SecLists,含 MinIO console 等面板发现)时使用
---

# 目录爆破

## 1. 基线校准(先做,防误报)
```bash
curl -s -o /dev/null -w "%{http_code} %{size_download}" http://<t>/RANDOMSTR9x7/
# 404/200+固定长度=基线;后续只报"状态或长度≠基线"的路径
```

## 2. 工具选择
```bash
# 快速起步(common.txt 4.6k):
ffuf -w /opt/tools/seclists/Discovery/Web-Content/common.txt -u http://<t>/FUZZ \
  -mc 200,204,301,302,307,401,403 -ac -t 25
# 加深(directory-list-2.3-medium 22万,值得时):
ffuf -w /opt/tools/seclists/Discovery/Web-Content/directory-list-2.3-medium.txt ... -recursion -recursion-depth 2
# 备份/压缩专项(高风险高命中):
ffuf -w <目标名+常见词> :EXT 变体 -u http://<t>/FUZZ.FUZ2Z -w2:zip,tar.gz,rar,7z,bak,sql,old
dirsearch -u http://<t>/ -e php,asp,jsp,html,zip,bak,sql,env -t 20
  (/opt/tools/bin/dirsearch 为薄包装: PYTHONPATH + python3 -m dirsearch)
```

## 3. 高价值目标清单(命中即报告)
- 管理面板:/admin /console(:9001 MinIO) /phpmyadmin /adminer /grafana /jenkins
  /kibana /harbor /nacos /druid /swagger /actuator
- 敏感文件:/.git/config /.env /.svn /web.config /.DS_Store /crossdomain.xml
- 备份:www.zip website.tar.gz <域名>.zip backup/ /db/*.sql
- 401/403 也是发现(有东西,进登录爆破线)

## 4. vhost/子域爆破(有 DNS 通配时)
```bash
ffuf -w /opt/tools/seclists/Discovery/DNS/subdomains-top1million-5000.txt \
  -u https://FUZZ.<domain>/ -mc 200,301,302 -H "Host: FUZZ.<domain>" -ac
```
