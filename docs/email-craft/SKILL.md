---
name: email-craft
description: 仿真钓鱼邮件制作 v2——预文本/头部一致性/内容混淆/多部分降级
---

# 邮件制作(线一) v2
[creates artifacts] 企业网关对抗级仿真。

## 头部一致性(第一优先——网关最先查的)
- Message-ID 域名 = From 域名(phish-send v2 自动做)
- Reply-To 同域或不设(不同域 = 红旗,v2 自动忽略跨域 reply-to)
- Date 时区与目标所在地一致(中国目标用 +0800)
- Return-Path = From 地址(直连时 envelope from 与 header from 对齐)

## 预文本库(按目标定制)
- IT 类:密码过期/VPN 配置/邮箱迁移/系统升级
- 人事类:工资条/考勤/绩效
- 共享文档类:OneDrive/钉钉/企微仿(带文件图标)
- 高管类:CEO 欺诈(需 OSINT 掌握组织架构)
- 个性化:用收件人真名/部门/上级姓名/近期公开事件

## HTML 规范 v2
- 全内联 CSS + base64 图片 + max-width 600px
- 双部分:纯文本降级 + HTML(部分客户端只读 plain)
- CSS 拆词:关键词用 <span style="display:inline"></span> 拆开
  (视觉无差,文字指纹不同)
- 按钮(不是裸链接):background 色 + border-radius + padding
- 页脚法务文本 + 收件人地址 + 取消订阅

## 追踪 URL 规范(v2 路径式)
- 点击: https://域/r/<uid>(不用 ?uid=xxx query 参数)
- 打开: https://域/o/<uid>.gif
- 域名选择:近似目标域(company-verify.co)或过期域抢注
