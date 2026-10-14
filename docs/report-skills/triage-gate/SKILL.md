---
name: triage-gate
description: report 席位在写 report_vulnerability 之前的复核关卡——七问门(逐问答不上=击杀该 finding)、四大预提交门、永拒清单、条件有效链表、CVSS 3.1 定级速查。只管单条 finding 的去留与定级; 继续扫描与扩大覆盖不归本技能。
---

# 落账前复核关卡(triage-gate)

一问答错 = 立即击杀**该 finding**, 转向**下一测试类**。

> **本技能中"STOP"的语义:** 这里的门只击杀未通过复核的**单个 finding**, 不授权停止项目。七问门杀掉某条 finding, 仅意味着*那一条*不进 report_vulnerability——项目里其余测试类仍待执行。覆盖轴的"DO NOT STOP"总纲属于方法论主技能, 不归本技能。

> 被复核打回(无效落账)伤整份报告的可信度; low/info 级中性。只把七问全过的写入 report_vulnerability。

## 攻击面信号(何时进本关)

- 任一席位(recon/api/exploit/postex 等)产出候选 finding, 准备 report_vulnerability 落账之前;
- 准备给某条 finding 标 critical/high 之前;
- 声称认证绕过/越权类结论之前(假阳性率最高的类别);
- 既往结论复现失败, 需要决定撤回还是保留。

## 方法步骤·第一关: 七问门(7-QUESTION GATE)

按序发问。任一问答错 = 立即停止。

### Q1: 攻击者能否**现在**就利用, 一步一步说清?

完整填写模板:
```
1. Setup:   I need [own account / another user's ID / no account]
2. Request: [exact HTTP method, URL, headers, body — copy-paste ready]
3. Result:  I can [read / modify / delete] [exact data shown in response]
4. Impact:  The real-world consequence is [account takeover / PII read / money stolen]
5. Cost:    Time: [X minutes], Capital: [$0 / $X subscription required]
```

**第 2 步写不成一条真实 HTTP 请求 → 击杀。**

### Q2: 影响是否属于授权范围接受的影响类型?

查授权范围文件里的"漏洞类型(Vulnerability Types)"/"Out of Scope"(排除项)。

常见分层:
- **Critical**: 无交互的任意用户 ATO、RCE、可 exfil 数据的 SQLi、管理员认证绕过
- **High**: 大规模 PII 外带、提权、带回数据的内部 SSRF、全量用户的存储型 XSS
- **Medium**: 特定用户非核心数据的 IDOR、敏感页面上需点击的 XSS
- **Low**: 非敏感信息泄露、带 PoC 的点击劫持

**映射到排除项 → 击杀。**

### Q3: 根因是否在授权资产内?

确认:
- 漏洞域名在授权清单内(不是 `*.internal.target.com` 这类内网域)
- 是生产资产(staging/dev 除非明确写入授权)
- 不是目标 merely 在用的第三方服务(不是 Stripe、Salesforce、Google Auth)

**出授权范围 → 击杀。**

### Q4: 是否依赖攻击者现实中拿不到的特权访问?

- "管理员能做 X" = 集权风险 = **击杀**(绝大多数情况)
- "非管理员能做只有管理员才能做的 X" = 有效
- "需要物理接触/MFA 设备" = 通常无效
- "需要先攻陷受害者账户才成立" = 存疑, 最多 low

### Q5: 是否已知/公认行为?

检索:
1. 公开披露报告/厂商 advisory: Ctrl+F 端点名+洞类
2. 目标仓库 GitHub issues: `is:issue label:security ENDPOINT_NAME`
3. Changelog/CHANGELOG.md——是否提及该行为
4. API 文档/设计文档——是否写明有意为之

**已被承认/属设计决策 → 击杀。**

### Q6: 能否证明"技术上可能"之外的实际影响?

- XSS → 展示真实 cookie 窃取或会话劫持, 不止 `alert(1)` 或 `alert(document.domain)`
- SSRF → 打到会返回数据的内部端点, 不止 DNS ping
- SQLi → 展示从真实表 exfil 数据, 不止报错信息
- IDOR → 响应中出现其他用户的真实数据, 不止一个 200 状态码

**只能证明"技术上可能" → 降级 severity, 不击杀。**

### Q7: 是否属于已知无效洞类?

查下方永拒清单。在清单上且不成链 → **击杀。**

## 层序陷阱(LAYER-ORDERING TRAP)——声称任何认证绕过前必读

**校验错误不能证明你通过了认证。**

这是认证绕过类中置信度最高的假阳性形态, 因为证据看起来很具体。失效的推理:

> "我发了未认证请求, 拿回 `400 — field X is required`。
> 校验错误说明请求过了 auth、到达了业务逻辑。
> 所以 auth 缺失。"

这个推断只在 auth 先于输入处理时才成立。很多技术栈把**全局输入净化器、body parser 或 schema 过滤器放在 auth 中间件之前**。畸形 body 在 auth 被咨询之前就被拒, 响应与"auth 已过、校验失败"无法区分。

**测试法: 用最小的好成型(well-formed) body 重发。**

```bash
# malformed body — trips the sanitiser, which runs FIRST
curl -s -X POST https://target/api/v1/resource -d '{'
# 400 {"code":"ERR-INPUT-0001","message":"Invalid text. Only permitted
#      characters are allowed"}                      <- looks like auth bypass

# same endpoint, well-formed empty object — now auth is reached
curl -s -X POST https://target/api/v1/resource -H 'Content-Type: application/json' -d '{}'
# 401 {"code":"ERR-AUTH-0001","message":"Not authenticated. Please log in."}
```

**只有第二个响应才告诉你 auth 层在哪。**

**真实授权项目教训。** 某生产 API 上, 畸形 body 在被测端点的绝大多数上返回校验形态的 `400`。若读成认证绕过, 那就是对着覆盖财务与管理操作的生产基础设施报一条 critical。实际是净化器在 auth 之前对 `{` 字符反应——那批端点对好成型的 `{}` 全部返回 `401`。这条假 critical 只因有人重测才避免。

**规则:**
- 层序从单一响应不可观测。绝不推断。
- 用 parser 能接受的*最简合法* body 探 auth, 不用畸形 body。
- 错误文本关于**输入形状或字符类**时, 你在跟 parser/净化器对话, 不是业务逻辑。
- 错误文本点名**业务字段**(`accountId is required`)且好成型 body 仍返回它, 才是真信号——进 Q6。
- 同样适用于 WAF 与 CDN 层: 边缘拦截不是源站响应。

## 方法步骤·第二关: 四大预提交门(4 PRE-SUBMISSION GATES)

顺序执行, 四门全过才算数。

### Gate 0: Reality Check(30 秒)
```
[ ] Bug is REAL — confirmed with actual HTTP requests, not code reading alone
[ ] Bug is IN SCOPE — checked the engagement's authorized scope explicitly
[ ] Reproducible from scratch — can reproduce starting from fresh session
[ ] Evidence ready — screenshot, response body, or video
```

### Gate 1: Impact Validation(2 分钟)
```
[ ] Can answer: "What can attacker DO that they couldn't before?"
[ ] Answer is more than "see non-sensitive data" (unless the engagement scope explicitly accepts info disclosure)
[ ] Real victim: another user's data, company's data, financial loss
[ ] Not relying on victim doing something unlikely
```

### Gate 2: Deduplication Check(5 分钟)
```
[ ] Searched public disclosed reports / advisories for this target + similar bug title/endpoint
[ ] Searched GitHub issues for target repo
[ ] Read most recent 5 disclosed reports for this target
[ ] Not a "known issue" in their changelog or public docs
[ ] Google: "TARGET_NAME ENDPOINT_NAME vulnerability"
```

### Gate 3: Report Quality(10 分钟)
```
[ ] Title: [Bug Class] in [Endpoint] allows [actor] to [impact]
[ ] Steps to Reproduce: copy-pasteable HTTP request
[ ] Evidence: screenshot/video of actual impact (not just 200 status)
[ ] Severity: matches CVSS 3.1 score AND engagement severity definitions
[ ] Remediation: 1-2 sentences of concrete fix
[ ] NEVER used "could potentially" or "may allow"
```

## 永拒清单(NEVER SUBMIT LIST)

把这些落账只会摧毁报告可信度。

```
Missing CSP / HSTS / security headers
Missing SPF / DKIM / DMARC
GraphQL introspection alone (no auth bypass, no IDOR demonstrated)
Banner / version disclosure without working CVE exploit
Clickjacking on non-sensitive pages (no sensitive action PoC)
Tabnabbing
CSV injection (no actual code execution shown)
CORS wildcard (*) without credential exfil proof of concept
Logout CSRF
Self-XSS (only exploits own account)
Open redirect alone (no ATO or OAuth theft chain)
OAuth client_secret in mobile app (known, expected)
SSRF DNS callback only (no internal service access or data)
Host header injection alone (no password reset poisoning PoC)
Rate limit on non-critical forms (search, contact, login with Cloudflare)
Session not invalidated on logout
Concurrent sessions
Internal IP in error message
Mixed content
SSL weak ciphers
Missing HttpOnly / Secure cookie flags alone
Broken external links
Autocomplete on password fields
Pre-account takeover (usually — very specific conditions required)
```

## 条件有效——必须成链(CONDITIONALLY VALID — CHAIN REQUIRED)

先搭链, 端到端证明可行, 然后才落账。

| Standalone Finding | Chain Required | Valid Result |
|---|---|---|
| Open redirect | + OAuth redirect_uri → auth code theft | ATO (Critical) |
| Clickjacking | + sensitive action + working PoC | Medium |
| CORS wildcard | + credentialed request exfils user PII | High |
| CSRF | + sensitive action (transfer funds, change email, delete account) | High |
| Rate limit bypass | + OTP/reset token brute force succeeds | Medium/High |
| SSRF DNS-only | + internal service access + data returned | Medium |
| Host header injection | + password reset email uses injected host | High |
| Prompt injection | + reads other user's data (IDOR) | High |
| S3 bucket listing | + JS bundles contain API keys or OAuth secrets | Medium/High |
| Self-XSS | + CSRF to trigger it on victim without their knowledge | Medium |
| Subdomain takeover | + OAuth redirect_uri registered at that subdomain | Critical |
| GraphQL introspection | + auth bypass mutation or IDOR on node() | High |

## CVSS 3.1 速查(severity 判定表)

### 常见评分示例

| Finding | Score | Severity | Vector |
|---|---|---|---|
| IDOR read PII, any user, auth required | 6.5 | Medium | AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N |
| IDOR write/delete, any user | 7.5 | High | AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N |
| Auth bypass → admin panel | 9.8 | Critical | AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H |
| Stored XSS → cookie theft, stored | 8.5 | High | AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:L/A:N |
| SQLi → full DB dump | 9.1 | Critical | AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N |
| SSRF → cloud metadata | 9.1 | Critical | AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:N |
| Race → double spend | 7.5 | High | AV:N/AC:H/PR:L/UI:N/S:U/C:H/I:H/A:N |
| GraphQL auth bypass | 8.1 | High | AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N |
| JWT none algorithm | 9.1 | Critical | AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H |

> **存储型 XSS 的 UI 是判断题。** 页面浏览即触发的存储型 XSS 是 CVSS 老牌灰色地带——NVD/FIRST 常给 UI:R(上表存储型 XSS 行会因此降到 ~7.6)。上表的 UI:N 建模的是"正常使用页面之外无需额外动作"; 若复核口径预期 UI:R, 先论证或重新打分, 再把数字写进报告。

### 指标速查

| What you have | Metric | Value |
|---|---|---|
| Exploitable over internet | AV | Network (N) |
| No special timing or race | AC | Low (L) |
| Free account needed | PR | Low (L) |
| No login needed | PR | None (N) |
| Admin needed | PR | High (H) |
| No victim action | UI | None (N) |
| Victim must click | UI | Required (R) |
| Reads all data | C | High (H) |
| Reads some data | C | Low (L) |
| Modifies all data | I | High (H) |
| Crashes service | A | High (H) |
| Affects only app | S | Unchanged (U) |
| Affects browser/OS/cloud | S | Changed (C) |

## 停止条件(快速击杀规则)

目标是快速淘汰坏线索, 省出时间打真洞:

1. **5 分钟规则**: Q1 模板 5 分钟填不完 → 转向下一类
2. **前置条件计数**: 同时需要的前置条件超过 2 个 → 击杀
3. **影响测试**: "攻击者最终拿到什么?"——没有有形所得 → 击杀
4. **管理员绕过**: "管理员能做 X"永远不是洞 → 立即击杀
5. **设计文档测试**: 属已文档化行为 → 立即击杀
6. **兔子洞信号**: Q6 上耗 30+ 分钟仍无可复现 PoC → 击杀

注意: 击杀的是**这条 finding**, 不是项目——按顶部 STOP 语义, 其余测试类继续。

## 定级前门(PRE-SEVERITY GATE)

在任何笔记或报告里给 finding 标 **critical/high** 之前——把下面每一问写成一行答案。答不具体, **定级就是错的**。

1. **我验证的是到"攻击者可达影响"的全链, 还是链中间的一个原语(primitive)?**
   —"第 N 层原语确认"≠可利用。多级链必须**所有**级都验证完, 定级才能对齐链的顶端。
2. **攻击者到底拿走什么, 一句话说清?**
   —"SP 前端 web 服务器上的 RCE"是具体的;"可能导致 RCE"不是——最多 high, 常见 medium。
3. **我本人端到端完整复现过至少两次吗?**
   —两次 = 发现时一次 + 报告截图/PoC 一次。不是"我确信能行"。
4. **链上还有继承门、签名校验、受众校验等验证步骤在拦着吗?**
   —有, 就不是 critical。以较低定级记为"原语存在", 直到绕过该门。
5. **授权方既往是否拒绝过这个定级类?**
   —不少口径把"无实际影响的信息泄露"封顶在 low/info, 不看数据类型。以授权范围文件为准。

**真实授权项目教训:** JWT `alg:none` 曾在"受众校验层确认签名绕过原语"的基础上被标 **critical**。后续测试显示签发方信任校验仍然拒绝无签名 token——完整 ATO 链没有走通, finding 被迫撤回。若草稿阶段跑过定级前门, Q1 会在落账前杀掉 critical 标签。

## 反模式(拉低落账质量)

```
Writing a report before confirming the bug exists (most common)
Reporting theoretical impact without proof
"The API returns more fields than necessary" (sensitivity matters — is it actually sensitive?)
Chaining A+B into one report when they're separate bugs (two separate reportable findings)
Reporting B saying "similar to A in my other report" — fresh Gate 0 for every bug
Overclaiming severity — reviewers trust you less next time
Under-describing impact — reviewer doesn't understand why it matters
```

即: A+B 明明是两个独立洞却并成一条落账 → 拆开各自定级; 每条 finding 都要单独过一遍 Gate 0。

## 撤回纪律(RETRACTION DISCIPLINE)

既往结论复现失败时——**绝不静默删除**。在报告附录记录撤回, 证明你验证自己的工作, 也省得复核方去追一条你已证伪的幻影。

**撤回条目模板:**

```markdown
### Retracted: <finding name>

- **Original signal:** <one-line description of what looked like a bug>
- **Disproving evidence:** <concrete reproduction-step + observation that disproves it>
- **Why it looked like a bug:** <root cause of the false positive — e.g., natural marker collision, network jitter, status-code-only confidence>
- **Retraction date:** <YYYY-MM-DD>
```

**真实授权项目中的具体撤回——模式参照:**

- **X-Forwarded-Proto 反射**——看似 4 个页面上的头反射; 实为 SP help-link href 里的字面词 `javascript`。原因: 标记不唯一。
- **Host 头 `:80@evil` 绕过**——常态 403 的路径返回 200 OK; body 与基线逐字节一致(8341 字节)。原因: 只看状态码的置信; ELB Host 归一化丢掉了 `@evil` 部分。
- **`download.aspx` 文件存在性 oracle**——看似跨路径类型的文件存在性区分器; 实为 SP 的文件扩展名黑名单(`.ashx`/`.asmx`/`.svc`/`.config` 无论存在与否一律拦截)。原因: 把服务端策略误当文件状态。
- **`Administrator` 时延泄露**——Authentication.asmx Login 单发 1527 ms vs 对照 ~700 ms; n=80 交错复现把每组压到 685-716 ms。原因: 单样本统计断言。

**为什么重要:** 附录里的撤回条目证明方法论诚实。静默删除看起来像挑数据。带撤回附录的 11 条报告, 比复核时垮掉 2 条的 13 条报告更可信。

## 衔接(工作流位置)

- **report 席位正文结构**——七问全过且定级前门干净时移交。本技能是写 report_vulnerability 之前的门; 只有过完 7Q+4 门的 finding 才进落账模板。
- **定级分类段**——本技能验证完后, 按 report_vulnerability 的 severity 语境(critical/high/medium/low)写危害描述与定级段。
- **证据留存与脱敏**——Q6 要求影响证明; 证据的采集与脱敏协议由证据纪律承接。
- **武器库 always-rejected/条件有效表**——本技能永拒清单与武器库 always-rejected 表对齐; 任一入口都能查到某原语可单独落账还是必须成链。
- **项目方法论 Phase 5(验证与报告)**——Phase 5 的报告前门显式调用本技能的 7Q 门, 然后才起草落账。

## 运维笔记(来自真实授权项目)

> 以下为方法论基线之上的实战增补: 来自真实授权项目与本技能体系 30+ 技能区的实弹验证。上游方法论讲 WHAT; 这一层讲 WHEN-IT-ACTUALLY-WORKS 与 FAILURE-MODES。

### 七问门在规模上的表现

7Q 门是本技能单项 ROI 最高的工件。加固实验室战役(Phase 2D)验证它杀掉四种不同的假阳性形态:

1. **URL 回显伪装成反射**——payload 出现在响应 body 里, 因为响应就是 URL。Q1(这是不是一条在服务端做了事的真实 HTTP 请求)击杀。
2. **词碰撞伪装成标记命中**——金丝雀串 `XSS-test` 撞上 CSS 类名, 不是你的注入。标记纪律+Q1 击杀。
3. **服务端策略误当状态 oracle**——`download.aspx?file=foo.config` 无论文件存在与否都返回"blocked"。Q6(超出技术上可能的影响)击杀: 没有 oracle, 只有 deny-list。
4. **无泄露的 200 OK**——状态码与基线 403 不同; body 逐字节一致。Body-Diff 规则+Q6 击杀。

不经 7Q 门, 一个项目预期 10-20% 的落账会被复核打回; 用了之后, 撤回率降到个位数。

### 报 critical 前的定级前门

某授权 SharePoint 项目差点提交一条链并未真正端到端走通的 critical——把"读 auth 状态的原语"与"改 auth 状态的原语"混为一谈。定级前门(把七个问题**专门对着 critical 主张**跑一遍, 而不是泛泛的"这是不是洞")能抓住它。

流程: 写出 critical 草稿标题。把七问中的"该洞"替换成 critical 主张逐问回答。若 Q6(超出技术上可能的影响)的答案是"我有一个应该能做 X 的原语, 但没在测试账户上端到端演示过 X", 降级。critical 意味着影响已演示, 不是影响可推断。

### 撤回纪律(运维口径)

落账后 24h 内 finding 停止复现——预防性撤回。两个理由:

1. **复核方替你撤回时是带着降级的。** 自撤读作"研究者验证自己的工作"; 被复核方撤回读作"研究者交了噪音"。
2. **落账有效率被长期跟踪。** 自撤与被关闭为无效对信任信号的损耗不同。你的可信度记录更干净。

上面撤回纪律一节的模板是标准格式。不要静默删除——改为给项目报告追加撤回附录。

### 7Q 显得碍事的时候

阻力就是门在起作用。被 7Q 杀掉的那一半 finding, 正是本来会被退回 low/info 的那一半。接受阻力。低置信 finding 停止稀释后, 单条落账的平均定级准确度上升。

例外: 7Q 杀了某条 finding 但你仍相信它——答案是**补证据**, 不是**绕门**。门是"你有没有证明"的检查。拿到证明, 再跑一遍门。

### 验证纪律规则交叉索引

七问是伞; 主方法论的纪律规则是落地实现:

| 7Q Question | Discipline Rule |
|---|---|
| Q1 (real HTTP request that does something) | Reproducibility Gate |
| Q2 (impact beyond informational) | Pre-Severity Gate |
| Q3 (server-side state change or data leak) | Server-Policy-vs-State |
| Q4 (cross-tenant / cross-user demonstrated) | OOB Gate (for blind class), Marker Discipline (for reflective class) |
| Q5 (not already known / dup) | disclosed-reports 索引 + 公开披露报告检索 |
| Q6 (impact beyond technically possible) | OOB Gate + Body-Diff Rule + Statistical-Sample Rule |
| Q7 (in scope per engagement rules) | 授权范围(scope)文件检索 |

某问难答"是"时, 交叉索引告诉你产出哪个工件能把答案变成"是"。Q6 是最多项目卡住的一问——所以有三条纪律规则支撑它。

## 证据要求

落账前逐条核对:

- **Q1 模板五要素齐**: 真实 HTTP 请求原文(方法/URL/头/body)+响应关键片段, copy-paste 可复现;
- **Q6 级影响证明**: 实际危害证据——回显数据片段、其他用户数据原文、OOB 回调记录、被窃会话凭据; 状态码差异不算;
- **层序验证对照**(认证绕过类必附): 畸形 body 与 well-formed body 两发请求的响应原文(如 400 vs 401), 证明 auth 层位置;
- **两次端到端复现**: 发现时一次 + 报告截图/PoC 一次;
- **成链 finding**: 链上每一环的请求/响应证据, 不只首环;
- **撤回条目四要素**: 原信号、反证(复现步骤+观察)、假阳性根因、日期。

## 落账

report_vulnerability 定级判定:

- **基线**: 按上方 CVSS 3.1 表打分定级; severity 必须与向量得分一致;
- **只有"技术上可能"**(Q6 不达标) → 按表降一档落地, 正文注明"影响未演示";
- **原语≠全链**: 链中间原语(如签名绕过被上游校验拦截)按原语本身定级并注明拦截点, 不得按链顶端定 critical;
- **critical 纪律**: 先过定级前门五问, 任一问答不具体 = 定级错误, 降级后再落;
- **永拒清单条目不落账**; 条件有效条目必须附完整链证明, 才按链表定级;
- **撤回**: 不静默删, 报告附录按模板补撤回条目。

相关 publish_intel:

- 被击杀的**假阳性模式**(层序陷阱、单状态码置信、标记碰撞、服务端策略误读)→ publish_intel 转情报, 供其他席位跳过同类弯路;
- 已验证的**绕过原语**(可复用的注入点/绕过手法)→ publish_intel 复用面情报;
- 击杀该 finding 的**范围/口径依据**(授权范围排除项)→ 随情报标注, 避免下游重复申报;
- 撤回条目的根因模式 → 并入假阳性情报。
