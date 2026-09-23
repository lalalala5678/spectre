---
name: smtp-send
description: SMTP 发送——配置/批量/速率控制/退信处理
---

# 发送(线二)
[side-effects: sends emails] /opt/tools/bin/phish-send.py

## SMTP 配置
1. 域名准备:SPF TXT 记录/DKIM 密钥/DMARC 策略
2. 发送通道按授权选择:
   - 直连(自有 VPS+域名):完全控制,但需配好 SPF/DKIM
   - 中继(SendGrid/Mailgun 免费层):送达率高
   - 第三代(现成 SMTP):速度慢但零配置

## 批量纪律
- phish-send.py --rate 5/min (默认)
- 单 campaign 发送量在 scope.json 配置
- 退信自动跳过,不重发硬退地址
