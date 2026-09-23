---
name: email-craft
description: 仿真钓鱼邮件制作——预文本/HTML 模板/发件人伪装/附件向量
---

# 邮件制作(线一)
[creates artifacts] 仿真度最大化=与真实攻击不可区分。

## 预文本库(scam scenarios)
按目标定制,常见族:
- 紧急通知类:密码即将过期/账号异常/安全警告
- 共享文档类:XXX 共享了文件给您(OneDrive/钉钉/企微仿)
- 人事类:工资条/考勤异常/绩效考核通知
- 高管类:CEO 欺诈(紧急转账/保密要求)
- IT 类:VPN 配置变更/邮箱迁移/系统升级

## HTML 模板规范
- 内联 CSS(邮箱客户端不加载外部样式)
- 品牌 logo(base64 内嵌,不外链)
- 响应式(max-width 600px 居中)
- 页脚法务文本+取消订阅(增加可信度)
- 追踪像素:<img src="{{TRACK_URL}}/open.gif?uid=X">
- 行动链接:{{TRACK_URL}}/click/X (指向着陆页)

## 发件人构造
- display name = 目标品牌(如 "IT 服务台")
- 实际地址 = 控制域(如 it-service@company-notify.co)
- reply-to = 攻击者收集地址
- 主题行:紧迫+具体(不含 "紧急!!!" 这类垃圾标记词)

## 附件向量(与 c2 agent 协作)
- 宏文档(.docm/.xlsm)——载荷由 c2 产出
- 快捷方式(.url/.lnk)
- HTML 附件(本地表单)
