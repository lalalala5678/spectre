---
name: pi-discovery
description: 需要排查目标是否存在未授权 PII 接口(学生/教师个人信息批量可读——教育SRC critical 判定的最高频面)时使用
---

# 未授权 PII 接口发现(教育 SRC critical 级最高频:批量个人信息泄露)

教育行业 SRC 对"批量师生个人信息可被未授权读取"普遍判 critical
(学号/姓名/身份证/手机/宿舍/成绩)。这类洞的本质是**未授权信息接口**,
不需要利用漏洞——发现即 critical。

## 1. 高价值接口模式(逐类探测,轻量)

```
# 教务/学籍类(正方/强智/青果/金智的历史接口)
/jwglxt/xsdaxx/query_xsxx / xsmain / /xskbcxx!list
/xjgl/学籍 / /xsdaxx / kbcx 课表查询
# 一卡通/图书馆
/ecard/api/user / oneCard / /lib/reader / opac/reader
# 就业/迎新/离校(新系统,常无鉴权)
/jyxt/ / yingxin / lixiao / /api/student/
# 统计/导出(最容易漏鉴权)
/export / download / report + xls/csv/pdf 后缀
# 数字校园开放 API
/api/v1/students / /uc/api/user / /portal/api
```

## 2. 遍历验证(证明"批量")
- 单个 ID 读到=线索;**ID+1 再读成功+含 PII 字段=critical 证据**
- 遍历上限:证明 2-3 个连续记录即停(不要真的拖库——安全线)
- 姓名返回可查 → 配合学号规律(OSINT 索引里的学号模式)说明可批量

## 3. 发现渠道
- 前端 JS 里的 API 路径(web-topology 的 JS 分析顺带收集)
- recon 台账里 200 公开的小系统(迎新/就业/二级学院站最常见)
- 老系统(2002-2015 年建设的 .aspx/.jsp)整站目录轻扫(robots/目录列表)

## 4. 判定与落账
- 单条 PII 未授权可读=high;连续 ID 可遍历+字段含身份证/手机=critical 候选
- 证据:2-3 条记录的响应片段(脱敏后段打码)+ 遍历可行性说明
- report_vulnerability 直接报(此类无需利用,critical 门槛清晰)
