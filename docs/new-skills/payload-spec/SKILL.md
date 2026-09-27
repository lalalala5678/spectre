---
name: payload-spec
description: 声明式载荷类型插件(Mythic 借鉴)——新协议=写 JSON spec
---

# c2-payload-spec(Mythic 借鉴)
[creates payloads] 协议/注入位/变换族/验证声明为 JSON——不改代码。

## 用法
```bash
c2-payload-spec.py list                        # 列出可用 spec
c2-payload-spec.py validate --spec my.json     # 校验 spec
c2-payload-spec.py gen --spec http-webshell.json --src payload.php --out /tmp/o --rounds 3
c2-payload-spec.py init                        # 初始化内置 spec
```

## spec 结构(必填)
```json
{
  "name": "http-webshell", "language": "php",
  "protocol": {"transport": "http", "beacon_interval": [30,120], "jitter": 0.3},
  "injection_points": [{"type": "query", "key": "c", "encoding": "raw"}],
  "transform_families": ["mask", "decomp", "id", "struct"],
  "validation": {"syntax_check": "php -l", "edusrc_block": true}
}
```

## 内置 spec
- http-webshell(php): query+cookie 注入
- http-jsp(java): header+body 注入
- http-ps(powershell): header 注入

## 新协议接入
写 spec JSON→validate→gen——引擎(c2-variant.py)按 spec 限定家族执行。
