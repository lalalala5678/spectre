---
name: bloodhound-ad
description: AD 权限图收集+分析——提权路径自动发现(BloodHound 借鉴)
---

# spectre-bloodhound(BloodHound 借鉴)
[side-effects: LDAP queries] 轻量实现:无需 neo4j。

## 用法
```bash
# 收集(需要任一域凭据)
spectre-bloodhound.py collect --dc 10.0.0.1 --domain corp.local --user user --pass pass --graph /tmp/ad.json
# 分析(6 类发现)
spectre-bloodhound.py analyze --graph /tmp/ad.json
# 单用户到 DA 的路径
spectre-bloodhound.py paths --graph /tmp/ad.json --from user1 --to "DOMAIN ADMINS"
```

## 检测项
- kerberoastable(SPN 用户→GetUserSPNs 离线爆破)
- asrep-roast(DONT_REQ_PREAUTH→GetNPUsers)
- pw-in-description(description 里的明文密码,critical)
- admincount-user(权限残迹)
- da-path(到 Domain Admins 的最短路径,组跳板链)

## Windows 靶机原生收集
/opt/tools/bin/SharpHound.ps1(1.3MB,PowerShell 版)——
`powershell -ep bypass -f SharpHound.ps1; Invoke-BloodHound -CollectionMethod All`

## 图语义
user -memberOf-> group -hasMember-> user2 -memberOf-> DA
(双向边: memberOf/member 互为镜像)
