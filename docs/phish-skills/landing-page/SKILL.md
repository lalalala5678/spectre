---
name: landing-page
description: 高仿真着陆页——品牌克隆/凭据表单/追踪注入
---

# 着陆页(线三)
[creates artifacts] 仿真度=目标品牌的镜像。

## 克隆流程
1. 访问目标真实登录页(授权范围内)
2. 保存 HTML+CSS+logo(base64 内嵌)
3. 替换表单 action → {{TRACK_URL}}/submit
4. 注入隐藏 uid 字段
5. 部署到控制域(子域名近似:portal.company-verify.co)

## 凭据处理(红线)
- 收到即 SHA-256 哈希——明文不落盘不传输
- 哈希仅用于统计"有提交",不用于登录尝试
- 报告只写"提交率",不写具体凭据
