<!-- 脱敏样例: 自动导出自任务报告 seq=10217(vAPI 战役终报), 内部引用号保留原样——它们仅在本仓库演示数据语境中有意义 -->

# vAPI 全端口渗透战役终报: 全课目打透

**状态**:success

## 任务
对 127.0.0.1 的 vAPI 靶场(github roottusk/vapi, OWASP API Security Top 10 全课目, PHP+MySQL 栈)进行渗透测试(全端口: 30080 vAPI 主应用, 30081 phpMyAdmin, 33306 MySQL——以及经 SSRF/注入可触达的内部面)。按开战流程: 首轮资产测绘→对账(授权清单已清空)→汇总授权申请→批准后全面渗透(OWASP API Top10: BOLA/BFLA/属性过度暴露/资源无限消耗/功能级授权缺失/批量赋值/SSRF/错误配置/库存/日志注入)→产出漏洞正本与终报。完整打透, 不设时限。

## 行动
## 执行时间线(2026-10-08 01:26→02:34)
1. **开战考古**: /tmp 遗留工件甄别——全部属上场 crAPI 战役(apitest/loop38_*/r54-report 等), 凭据不通用已隔离(情报 seq=10082); 继承环境知识(OOB 收集器 19999)。
2. **被动测绘+授权门**: 目标存活确认(30080/30081)、GitHub 白盒源码克隆入工作区(/workspace/ws-muyuw01l-b9l7/vapi-src)、路由表/种子库/docker-compose 提取; 127.0.0.1 授权(seq=10083)→批; recon 发现三容器 172.18.0.2/3/4→逐项申请(seq=10129-10131)→全批; 容器角色编排器直连判别(.2=db MySQL/.3=www vAPI/.4=phpMyAdmin)。
3. **主波 eng-muyvu3fu(4 席并行)**: recon(全端口+指纹+拓扑+/_ignition 面)、weakcred(MySQL root@%/phpMyAdmin/api2/api5 四线凭据黑盒验证+库内只读取证)、api(OWASP API Top10 全课目 13/13 黑盒矩阵)、exploit(SSRF 全链 PoC+JWT 验签缺失+RCE 攻坚论证)。
4. **追加波 eng-muywmimg**: nday 四指纹定向 CVE 对账(18 模板+全量版本窗推理)。
5. **协同修正**: OOB 回连地址修正(172.18.0.1:19999)、RCE 判收口径修正(同步自证优先)、api8 影响标尺(secure_file_priv 受限勿夸大 RCE)、去重通知×2(jwt/api5/SSRF)。
6. **对账**: 每席位终报与漏洞正本逐条 query_intel 对账; api 系统代拟占位(10204)后自行补交正报(10212)以正报为准。

## 结果
**战役终态: vAPI 靶场全数据面沦陷(预期课目 100% 打透), 主机 RCE 经完整论证不可达成(靶上已修+结构性无出口), 阴性结论同样有据。**
- OWASP API Security Top10 全课目黑盒实证 13/13(flag 全取): BOLA(api1 读写/api2)、认证失效(api2 静态令牌/api4 固定 OTP 1872/jwt 验签缺失)、属性级授权(api3)、BFLA(api5 普通用户调管理面)、批量赋值(api6 credit)、SSRF+任意文件读(serversurfer file://+php://filter 读 .env)、错误配置(api7 CORS 反射+/_ignition 暴露+基础设施弱口令)、注入(api8 SQLi+stickynotes 存储型 XSS)、库存管理(api9 v1/v2 并存)、资源消耗(api9 v1 无限流)、日志监控(api10 无鉴权+dashboard 永真)。
- 基础设施: MySQL root@% 全权限、phpMyAdmin 管理入口、SSRF 内网触达(172.18.0.0/16 三容器全景)、www 容器任意文件读。
- RCE 终局(诚实边界): CVE-2021-3129 靶上已修(ignition 2.12.0 isSafePath+log delta=0 双黑盒证)、无上传/反序列化/可写执行面、MySQL secure_file_priv 受限(OUTFILE 仅 /var/lib/mysql-files/ 并已写读闭环证明); 纯黑盒 RCE 不可达为论证结论而非未尝试。
- nday 全阴(2026 新部署与历史 CVE 窗全错开), 附条件不足清单供环境变化时复活。
- 纪律: 零破坏(写向全回滚)、授权门 100% 合规(两轮申请全批后打)、污染源隔离。

## 证据
## 漏洞正本 19 条(全部 report agent 独立复核落账)
- **critical×1**: api8 登录 SQL 注入认证绕过(seq=10192)
- **high×13**: api1 BOLA 读/写(10121)、api2 全表泄露(10149)+静态令牌(10156)、api3 属性级(10164)、api4 固定 OTP 重放(10170)、api5 BFLA+弱凭据(10136)、api6 批量赋值(10184)、api7 CORS 反射(10188)、api9 v1 无限流(10198)、api10 无鉴权(10200)、SSRF 任意文件读(10172)、JWT 验签缺失(10175)、MySQL root@% 弱口令(10119)、phpMyAdmin 弱口令(10123)、全库明文口令(10152)
- **medium×5**: stickynotes 存储型 XSS(10202)、dashboard/flag 永真(10207)、/_ignition 调试面暴露(10165)等
- 关键 PoC 证据链: SSRF php://filter 读 .env(APP_KEY+DB 凭据)、MySQL INTO OUTFILE 受限目录写+LOAD_FILE 读回闭环、api8 `admin' %23`→authkey→secret、api5 普通用户 attacker5→/users 管理面全表、api6 credit=100000 写后读、api9 v1 200×8 vs v2 500×4 对照矩阵
- flag 13/13(api1-10+jwt+xss)全部黑盒取得
## nday 阴性台账(有效产出)
18 模板全阴(引擎阳性对照 7.4.33 命中证明有效)+ 版本窗推理: MySQL 8.0.46 对 173 个 2025/2026 CVE 零命中、Apache 2.4.65 窗内 13 项条件全不满足、PHP 8.3.26/7.4.33 条件面均不存在; 四态: 可利用 0/绕过 0/不适用~55/条件不足~8
## 任务报告
recon=10132 / weakcred=10159 / api=10212 / exploit=10176+10193 / nday=随后落账

## 资产/环境
127.0.0.1:30080 (vAPI 1.1, Laravel 8.57/PHP 7.4.33 cli-server, 容器 172.18.0.3:80); 127.0.0.1:30081 (phpMyAdmin 5.2.3, Apache/2.4.65+PHP 8.3.26, 容器 172.18.0.4:80); 127.0.0.1:33306 (MySQL 8.0.46 mysql_native_password, 容器 172.18.0.2:3306); docker 桥 br-606266a7d481 (172.18.0.0/16) 内部面(经 SSRF/直连双通道); 白盒源码 /workspace/ws-muyuw01l-b9l7/vapi-src。授权清单: 127.0.0.1, 172.17.0.1, 172.18.0.1-4。

## 限制
1. www 容器 RCE 不可达(已论证非可达成, 非未尝试): ignition 2.12.0 已修、无上传、L8 cookie 反序列化默认关、public/ 无可写执行面。
2. MySQL secure_file_priv=/var/lib/mysql-files/ 受限, 非 web 可达路径, 不构成 RCE 链。
3. 平台 OOB 收集器日志沙箱内不可读, 盲回连不可判真——全程以同步回显自证替代。
4. PHP 7.4.33 EOL 无修复区间, 黑盒不可区分未修项(边界已注明)。
5. /tmp 跨战役共享, crAPI 凭据工件全程隔离未误用; 无 mysql CLI 环境(pymysql 替代)。

## 产出漏洞
- vAPI /vapi/api8/user/login SQL注入认证绕过(CWE-89)
- vAPI /vapi/api1/user/{id} BOLA(CWE-639)
- vAPI /vapi/api2/user/details 任意令牌 BOLA(CWE-285)
- vAPI api2/user/login 永不过期静态会话令牌(CWE-613)
- vAPI /vapi/api3/comment 属性级越权(CWE-915/306)
- vAPI /vapi/api4 固定OTP重放认证绕过(CWE-330)
- vAPI /vapi/api5/users BFLA 弱默认凭据(CWE-798/285)
- vAPI /vapi/api6/user 批量赋值(CWE-915)
- vAPI /vapi/api7/user/key CORS 任意 Origin 反射(CWE-942)
- vAPI /vapi/api9/v1/user/login 无限流 PIN 穷举(CWE-307)
- vAPI /vapi/api10/user/flag 无鉴权敏感端点(CWE-306)
- vAPI /vapi/serversurfer 未鉴权 SSRF/任意文件读(CWE-918)
- vAPI /vapi/jwt/user JWT 签名验证缺失(CWE-347)
- vAPI MySQL(33306) root@% 默认弱口令(CWE-798)
- vAPI phpMyAdmin(30081) root 默认弱口令(CWE-798)
- vAPI 全线用户口令明文存储与跨用户复用(CWE-256)
- vAPI /vapi/stickynotes 存储型XSS(CWE-79)
- vAPI /vapi/dashboard/flag 提交校验永真(CWE-670)
- vAPI /_ignition 调试面板未授权暴露(CWE-489)

## 后续建议
1. 修复优先级: ①轮换全部默认凭据(MySQL root@%/phpMyAdmin/vapi123456、api5 admin)②api8 参数化查询止血(唯一 critical, 未认证可达)③全库口令改 bcrypt 哈希④serversurfer 加白名单+鉴权⑤api1-10 逐课目对象级鉴权改造。
2. 若环境变化复活条件: nday 台账 B 节 8 行条件不足项(.shtml/SSI/mod_md/proxy 面)可直接复验。
3. 白盒源码保留于 /workspace/ws-muyuw01l-b9l7/vapi-src 供复核; 全部写向测试已回滚, 靶场可复用。
