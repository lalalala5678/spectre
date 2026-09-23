---
name: api-inject
description: 注入族(线四武器化)
---

# 注入族(线四武器化)
[轻探测] SQL/NoSQL/GraphQL/JSON/批量赋值。安全线:只读证明。

## SQL 注入
三态起步:单引号/双引号/反引号×{错误型,UNION 型,时间型}。
- 错误型:500/数据库报错文案(MySQL/Oracle/MSSQL 指纹)
- UNION:ORDER BY 探列数(1-2 发)→UNION SELECT 标记(仅取 version()/user())
- 时间型:SLEEP(2) 延时对照(同请求无 payload 基线);数据库函数族按指纹选
- 教育老栈高发位:order by/limit/in 子句/like/报表导出参数/历史查询
- 证明=SELECT 一条 version() 或等延时差,绝不 INTO OUTFILE/写

## NoSQL(Mongo 面)
{"$ne":null}/{"$gt":""}/{"$regex":"^a"} 三件套;JSON body 与查询参数两通道。

## GraphQL 注入
内省→嵌套深度(证明 100 层被拒/接受即停)/alias 批量(1 发证明)/
mutation 参数注入(SQL/命令)。

## JSON 结构注入
{"a":{"role":"admin"}} 层级混淆;数组绕过([...] 绕单对象校验);
类型混淆("id":1 vs "id":"1")。

## 批量赋值(mass assignment)
POST/PUT 注册/资料接口带 role/is_admin/status/balance/userType/
permissions——改完必须读回(GET 或重登录)确认持久化才算数
(状态码差异不算证据,Rule 23:写后读回)。

## 8. 令牌弱密钥爆破(跨线复用 weakcred 平台资产,通用)
自签/自验令牌(JWT/自定义 body.sig)的 secret 爆破不要用静态弱口令表——
用 weakcred 的语义候选管道生成:
- 基词:服务语义(school/campus/edu/app/api/web/vip/admin)+目标缩写
- hashcat 规则:/opt/tools/dicts/brute_base.rule+brute_suffix.rule 两段
  (--stdout,实例锁:落盘串行),year/special 全形态
- 拼接形状:md5/sha 系(secret+body)/(body+secret)/(body+salt+secret)×
  截断 16/32——先从任意合法令牌反推形状(改一位 sig 看校验位长度)
92 词静态表打不穿 school2026 型 secret;语义管道才是正解

## 9. SQLite 时延原语(盲注唯一可靠形状,apibench 实证)
SQLite 无 SLEEP/PG_SLEEP。标准时延载荷:
`AND 1=LIKE('ABCDEFG',UPPER(HEX(RANDOMBLOB(N))))--`(N=字节数,300M≈2s)
- 剂量线性自证:三剂量(如 300M/30M/基线)时延成比例才算通道成立,
  单次时延差可能是网络抖动
- 匹配行前提:WHERE 条件需命中行(course='真实值'),恒假条件短路不执行
  randomblob——这是"盲注无时延"最常见假阴性原因
