---
name: smtp-send
description: SMTP 发送 v2——DKIM 签名/域名预热/多通道/批量纪律
---

# 发送(线二) v2
[sends emails] phish-send.py(v2)

## DKIM 必配(无 DKIM = 进垃圾箱)
```bash
# 生成密钥对+DNS 记录(一条命令)
phish-send.py genkey --genkey-domain yourdomain.co --genkey-selector s1
# 输出: 私钥路径 + DNS TXT 记录(贴到 DNS 服务商)
# SPF: yourdomain.co. IN TXT "v=spf1 ip4:<发送IP> ~all"
# DMARC: _dmarc.yourdomain.co. IN TXT "v=DMARC1; p=none"
```

## 域名预热(不可跳过)
新域名直接发 = 被拒。流程:
- 第 1-7 天:每天 5-10 封正常邮件(给 Gmail/QQ/163)
- 第 2-3 周:逐步提到 50-100 封/天
- 观察退信率:<5% 才可上量
- 期间逐步提高 DKIM 对齐率

## 发送通道选择
- 直连 VPS:完全控制,需 SPF/DKIM/预热
- SendGrid/Mailgun 免费层:送达率高但域名可能被关联
- 第三方 SMTP:慢但零配置

## 批量纪律
- --rate 5/min 起,观察网关反应
- 硬退地址立即拉黑
- 每 campaign 审计落账(audit.log)
