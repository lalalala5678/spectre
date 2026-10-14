---
name: race-condition
description: 触发于金融/配额/投票/一次性约束类端点(优惠券与礼品卡双重核销、MFA-OTP 校验竞态、账户创建竞态、限流绕过、TOCTOU), 覆盖 HTTP/2 单包攻击与万请求首序列同步; 纯业务逻辑漏洞(无并发触发条件的状态机缺陷)归 api-logic。
---

# 竞态条件(Race Condition)

源自 12 份公开披露报告的现代竞态条件利用技能, 含 HTTP/2 单包攻击(James Kettle, DEF CON 2023 "Smashing the State Machine")与 RyotaK / Flatt Security 2024 年的万请求首序列同步扩展。

## 攻击面信号

### 高价值目标

竞态条件是高危发现, 因为它破坏了防守方很少压测的金融、访问控制与完整性假设。最高价值的方向:

- **货币/积分系统** —— 礼品卡、优惠券、推荐奖励、促销积分、钱包余额的双重支付
- **投票/声誉操纵** —— 同一内容多次点赞、操纵排行榜或热门算法
- **账户配额绕过** —— 超出免费额度、绕过邀请/试用激活/API key 生成上的"每用户一次"限制
- **权限提升** —— 在用户创建/升级流程中竞争角色分配或权限检查
- **删除绕过** —— 在"标记删除"到"实际删除"的窄窗口内读取或带出数据
- **支付流程** —— 一次扣款却获得多次履约

**最易出高危的资产类型:** 金融科技应用、带积分/订阅模型的 SaaS 平台、带声誉系统的社交平台、电商结账流程、OAuth/SSO token 端点。

### URL 模式
```
/vote, /upvote, /like, /favorite
/redeem, /apply-coupon, /use-code, /claim
/purchase, /checkout, /confirm-order, /pay
/transfer, /withdraw, /send-money
/invite, /referral, /accept-invite
/upgrade, /activate, /trial
/delete, /deactivate, /cancel
/follow, /subscribe
```

### 提示竞态易感后端的响应头
```
X-RateLimit-*        # rate limiting exists, but may not be atomic
X-Request-Id         # each request independently tracked
No Cache-Control     # stateful ops not idempotent
```

### 可 grep 的 JavaScript 特征
```javascript
// Single-use action buttons with client-side disable
button.disabled = true
$('#btn').prop('disabled', true)
// Optimistic UI updates (state set before server confirms)
setState({ used: true })
// Sequential async calls without locking
await useVoucher(); await deductBalance();
```

### 技术栈信号
- **Ruby on Rails** 未用 `with_lock` / `lock!` —— ActiveRecord 默认不加锁
- **Node.js** async/await 链 —— 数据库先读后写非原子
- **PHP** 无 `SELECT ... FOR UPDATE` —— 遗留代码库常见
- **微服务** —— 服务间调用天然引入 TOCTOU 窗口
- **Redis 计数器** 无 Lua 脚本或 `INCR` 原子性检查
- **消息队列** —— 常缺幂等键

## 方法步骤

### 触发竞争——两种原语(工具无关)

赢得竞态需要请求落在*同一个*窄窗口内到达——串行发送永远无效。使用单包/同步发送工具: **Burp Repeater** "Send group in parallel"(HTTP/2 单包攻击)、**Turbo Intruder**(`engine=Engine.BURP2`, `gate` 同步), 或任何能同时 flush N 个请求的客户端。两种形态:

- **同副本竞争(identical-copies race)** —— 一次性发出同一个请求的 N 份**完全相同**副本(限量超扣: 礼品卡/优惠券双花、突破每用户一次配额)。成功判据 = N 个中 ≥2 个返回 2xx。
- **异请求竞争(different-requests race, 部分构造)** —— 在一个同步窗口内发出一**组不同的**请求列表, 重复多轮。适用于 register-then-confirm / TOCTOU 类竞争, 即对象在创建中途处于可用状态的场景。示例(邮箱验证绕过——注册任意邮箱, 然后在构造窗口内用空 token 完成确认):
  ```
  Request A:  POST /register   body: csrf=<csrf>&username=hacker&email=anything@exploit.net&password=pw
  Request B:  GET  /confirm    params: token=   (empty)
  Fire A and B together, repeat ~20 rounds.
  ```
  先从 `GET /register` 拿新鲜 CSRF, 再整批发射。成功后以新账户登录并执行目标动作(如删除用户这类改状态的管理操作)。空 token 确认之所以能赢, 是因为用户行已存在而验证 token 尚未写入。

### 十步猎杀方法论

1. **枚举一次性/限量动作** —— 梳理所有实施"每用户一次"、"限量"、"扣减余额"约束的端点, 这是首要目标。

2. **理解状态机** —— 对每个目标动作弄清: (a) 读什么状态, (b) 写什么状态, (c) 读与写之间有什么校验。读写之间的间隙就是你的窗口。

3. **抓取干净的基线请求** —— 用 Burp Suite 拦截, 合法执行一次动作, 确认得到预期的一次性行为(如优惠券被标记已用、投票只计一次)。

4. **搭建并行请求工具** —— 任选其一:
   - Burp Suite Repeater → "Send group in parallel"(HTTP/2 单包攻击用 Turbo Intruder)
   - Turbo Intruder `engine=Engine.BURP2` 做末字节同步
   - `curl` 加 `&` 后台并发
   - Python `threading` 或 `asyncio` 预建连接

5. **执行竞争** —— 同时发送 10–50 个相同请求。关键手法: **预连接并缓冲全部请求, 同时释放所有请求的最后一个字节**(目标支持 HTTP/2 时即单包攻击)。

6. **分析响应** —— 关注:
   - 只应成功一次却出现多个 `200 OK`
   - 重复的成功消息
   - 数据库约束报错(说明竞争奏效但撞上了最后一道防线)
   - 响应时间不一致(一个快其余慢 = 串行处理; 全部同速 = 并行处理)

7. **验证实际效果** —— 检查真实状态: 积分到账两次? 投票计数多次递增? 两次成功后优惠券仍标记未用?

8. **测定可利用窗口** —— 递减并行度重跑(5 发、3 发、2 发), 弄清窗口有多紧、利用有多可靠。

9. **跨账户类型测试** —— 有些竞争只对新账户、特定订阅档位或特定服务器负载下成立, 变换条件测试。

10. **记录可复现性** —— 上报前记录确切时序、所需并行请求数、以及 5 次独立尝试中的成功率。

### Payload 与检测模式

#### Turbo Intruder——基础并行竞争
```python
# turbo_intruder_race.py
def queueRequests(target, wordlists):
    engine = RequestEngine(endpoint=target.endpoint,
                           concurrentConnections=1,
                           engine=Engine.BURP2)  # HTTP/2 single-packet
    for i in range(20):
        engine.queue(target.req, gate='race1')
    engine.openGate('race1')

def handleResponse(req, interesting):
    if '200' in req.status:
        table.add(req)
```

#### curl——并行请求(bash)
```bash
# Fire 15 simultaneous vote/redeem requests
for i in $(seq 1 15); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST "https://target.com/api/vote" \
    -H "Cookie: session=YOUR_SESSION" \
    -H "Content-Type: application/json" \
    -d '{"report_id": "12345", "vote": "up"}' &
done
wait
```

#### Python asyncio 竞争
```python
import asyncio, aiohttp

async def race_request(session, url, payload, headers):
    async with session.post(url, json=payload, headers=headers) as r:
        return await r.text()

async def main():
    url = "https://target.com/redeem"
    payload = {"code": "GIFT50"}
    headers = {"Cookie": "session=XXXXX"}
    
    async with aiohttp.ClientSession() as session:
        tasks = [race_request(session, url, payload, headers) for _ in range(20)]
        results = await asyncio.gather(*tasks)
    
    for r in results:
        print(r[:100])  # print first 100 chars of each response

asyncio.run(main())
```

#### 源码审计 grep 模式
```bash
# Look for read-then-write without locking
grep -rn "find_by\|where.*first" --include="*.rb" | grep -v "lock"
grep -rn "SELECT.*WHERE" --include="*.php" | grep -v "FOR UPDATE"

# JavaScript async without atomicity
grep -rn "await.*get\|await.*find" --include="*.js" -A2 | grep "await.*update\|await.*save"

# Python Django ORM without select_for_update
grep -rn "\.get(\|\.filter(" --include="*.py" | grep -v "select_for_update"
```

#### HTTP/2 单包检查
```bash
# Verify target supports HTTP/2 (prerequisite for single-packet attack)
curl -sI --http2 https://target.com | grep -i "HTTP/2\|h2"
```

### 常见根因

1. **先检查后执行且无原子操作** —— 开发者读状态(`if voucher.used == false`)再写状态(`voucher.update(used: true)`), 两次独立数据库操作。任何线程都可能在任一方写入前读到同一个"未用"状态。

2. **缺数据库级锁** —— 用 `find`/`filter` 这类 ORM 方法而非 `SELECT ... FOR UPDATE`。修复只需一行, 但开发者不考虑并发。

3. **乐观并发无版本检查** —— 系统递增计数器或标记记录时不检查记录自读取后是否已变。

4. **微服务 TOCTOU** —— 服务 A 校验资格, 服务 B 执行动作, 没有横跨两服务的原子事务。

5. **客户端"防护"** —— 开发者用 JavaScript 在首次点击后禁用按钮, 以为能防重复提交, 服务端逻辑从未加固。

6. **计数器递增在事务外** —— `votes_count += 1; save()` 而非原子 SQL `UPDATE SET votes = votes + 1 WHERE id = ?`。

7. **异步后台任务** —— 资格校验同步完成, 履约异步执行。第二个请求在首个任务完成前通过校验。

8. **缓存无失效** —— 缓存的"用户是否已投票"检查在首次写入尚未传播的缓存窗口内返回过期的 `false`。

### 绕过技术

#### 防守方实施方案(与绕过方法)

**防御: 按用户限流**
- 绕过: 限流检查发生在动作执行之前。同时发送请求——全部在任何一次被计数之前通过限流检查。

**防御: 幂等键/唯一请求 token**
- 绕过: 若服务端生成或复用 token, 尝试不带 token 发并行请求; 或检查唯一性校验本身是否存在竞态窗口。

**防御: 数据库唯一约束**
- 绕过: 约束在竞争*之后*才拦截重复。前两个可能在数据库强制执行前都已成功。留意部分履约——有时一个成功一个报错但两个都被兑现。

**防御: 短时间窗/过期 token**
- 绕过: 预置全部携带有效 token 的请求。用 HTTP/2 单包在一个 TCP 帧内全部释放——服务端在同一调度槽内处理。

**防御: 队列串行化**
- 绕过: 多队列(或多 worker 消费同一队列)可能取到重复消息。在窗口期内压垮队列进行测试。

**防御: 应用层互斥锁**
- 绕过: 分布式系统多应用服务器不共享进程内锁。经不同 CDN 节点或负载均衡服务器向同一端点发请求。

**防御: 应用代码里的"已使用"检查**
- 绕过: 检查与更新是分离的。两个竞争请求在任一更新完成前都通过检查。只有原子 `UPDATE ... WHERE used=false RETURNING id` 才能真正防住。

### HTTP/2 单包攻击——深度参考

单包攻击是 2020 年以来最重要的竞态技术。它把竞争窗口从"带 TCP 握手抖动的数十毫秒"压缩到"服务端 worker 池分发 N 个预缓冲请求的时间"——整批通常 **1 ms 以内**。这使现代竞态利用在限流、分布式、负载均衡的后端上变得可行——它们此前看似无法被竞争。

原始研究: **James Kettle, PortSwigger — "Smashing the State Machine"(DEF CON 31, 2023 年 8 月)** [portswigger.net/research/smashing-the-state-machine](https://portswigger.net/research/smashing-the-state-machine)。2024 扩展: **RyotaK / Flatt Security — "Beyond the Limit: Expanding Single-Packet Race Condition with First Sequence Sync"** [flatt.tech/research/posts/beyond-the-limit-expanding-single-packet-race-condition-with-first-sequence-sync/](https://flatt.tech/research/posts/beyond-the-limit-expanding-single-packet-race-condition-with-first-sequence-sync/)。

#### 为什么有效——架构原理

竞争利用失败有两个原因, 看似同一问题实则不同:
1. **网络抖动** —— 同一 TCP 连接串行发出的 N 个请求到达服务端时带 0.5–5 ms 的离散度, 取决于 RTT 与拥塞。
2. **服务端分发顺序** —— 即使 N 个请求同一毫秒到达, worker 池也可能经负载均衡器或 accept 队列串行化。

单包攻击利用 HTTP/2 的两个协议层事实解决 (1):

- HTTP/2 在一条 TCP 连接上多路复用 N 个请求, 每批请求一个 TLS 记录。
- TLS 记录可承载多个 HTTP/2 `HEADERS` 帧, 每个 HEADERS 帧可以是独立流的最后一帧。

因此, 若在单条 HTTP/2 连接上预置 N 个请求——**发送每个请求除最后一个字节外的全部 HEADERS 帧, 然后在一次 TCP 写入中释放所有末字节**——TCP 协议栈会以**一个 IP 包**发出(前提 < MTU, 约 1500 字节)。服务端内核在同一调度 tick 内把全部 N 个请求交给 HTTP/2 解析器。竞争窗口不再取决于网络, 而是应用自身的原子性失效窗口。

至于 (2) 服务端分发顺序——Kettle 证明现代后端(Node.js、Go、异步 Python)收到一个含 N 个预解析请求的包时会在微秒级并发分发。老式阻塞后端(默认 Apache prefork、单线程 PHP-FPM)即使单包送达也串行; 对这类目标该技术收效较小, 但仍优于 TCP 流顺序发送。

#### 末字节同步技术

Kettle 记录的确切机制:

1. 开一条 HTTP/2 连接。协商 TLS, 发送 SETTINGS 帧, 接收服务端的。
2. 对 N 个请求中的每一个, 发送其 `HEADERS` 帧(**带 END_HEADERS 标志**)和一个包含 **body 除最后一字节外全部内容**的 `DATA` 帧。此时**不要**置 END_STREAM。
3. 服务端无法分发该请求, 因为 END_STREAM 未到——它在等最后一个字节。
4. 在同一连接上对全部 N 个请求重复 (2)。每个请求此刻都缓冲在服务端, 解析到"差一点完成"。
5. **在一次 TCP 写入中, 发送 N 个各含 1 字节、置 END_STREAM 的微型 `DATA` 帧。** TCP 把它们合并为一个出站段。服务端 HTTP/2 解析器在同一调度 tick 内看到全部 N 个流的 END_STREAM。
6. 服务端在微秒级把 N 个请求分发给 N 个 worker。

竞争窗口等于 worker N 的 `SELECT ... FOR UPDATE` 与 worker N+1 同一查询之间的时间——worker 跑在同一 CPU 上时通常是纳秒级。

#### Wireshark 验证

确认攻击工具真正产生单包同步(而非意外分片):

1. 攻击期间抓回环或出口网卡: `sudo tcpdump -i lo0 -w race.pcap port 443`(或 0 号网卡)。
2. Wireshark 打开, 过滤 `tls and tcp.port == 443`。
3. 找到含 END_STREAM flush 的 TLS 记录。它应当是**一个 TLS 记录、一个 TCP 段内含 N 个置 END_STREAM 的 H2 DATA 帧**。
4. 若看到 N 个 TLS 记录或 N 个 TCP 段, 说明你的工具在顺序发送。竞争窗口就是段间隙——通常太宽。

Turbo Intruder 的 `engine=Engine.BURP2` 实现在请求 body 不超 MTU 时保证 HTTP/2 目标上的单包送达。更大的 body 见下文"竞态窗口估算"小节。

#### h2.0 单帧 vs h2.cl 多帧竞争

依目标协议而定的两个变体:

- **h2.0 单帧**(标准 Kettle 攻击): 端到端纯 HTTP/2。一个 TLS 记录内 N 个请求。适用于任何前端在 ALPN 通告 `h2` 的现代 HTTPS 目标。**默认打法。**
- **h2.cl 多帧**: 前端对客户端讲 HTTP/2, 对后端降级为 HTTP/1.1。近似请求走私——构造一个 `Content-Length` 混淆前端的 HTTP/2 请求, 使其对后端在同一连接上发出两个 HTTP/1.1 请求。与 HTTP 请求走私配合使用。适用于前端过滤了单包 HTTP/2 但后端可达 HTTP/1.1 的场景。

用 `curl -sI --http2 https://target.com | grep -i HTTP/2` 检测 h2.0 可行性。服务端不讲 h2 时单包攻击不直接适用——退回 HTTP/1.1 上的"并行流水线"(竞争窗口宽得多; 对现代后端通常输掉竞争, 但对朴素后端仍有用)。

#### 竞态窗口估算方法论

发射攻击前先估算竞争窗口。这决定你是否需要单包、以及发多少并发请求。

1. 向目标端点发**单个**请求, 抓线上响应时间: `T_single`。
2. 发**两个串行**请求, 抓两个响应时间: `T_seq1`、`T_seq2`。
3. 经同一连接(HTTP/2 多路复用或 HTTP/1.1 流水线)发**两个并发**请求, 抓两个: `T_par1`、`T_par2`。
4. 若 `T_par1 ≈ T_par2 ≈ T_single`, 服务端并行处理——竞争窗口为 `min(T_par1, T_par2)`, 单包帮助极大。
5. 若 `T_par2 ≈ T_par1 + T_single`, 服务端串行——竞争窗口是串行 worker 之间发生的事; 单包帮助较小但仍优于 TCP 抖动。
6. PIN / OTP / 优惠券核销类端点, 预期 `T_single` 为 10–100 ms(数据库查询延迟)。服务端内部竞争窗口通常 < 1 ms(同一行上 `SELECT` 与 `UPDATE` 之间的间隙)。
7. **N 值经验法则:** 单包 h2 从 `N = 30` 并发起步。目标 `T_single` < 10 ms 时(极快端点 = 需要更大预缓冲以淹没 worker 池)加到 100+。配合 Flatt 首序列同步扩展最高可达 **10,000**(见下)。

#### 单连接多流 vs 多连接单流

选择形态的决策树:

- **单连接 N 流**(默认 Kettle / Turbo Intruder BURP2 引擎): 一条 TCP 连接上 N 个并发 HTTP/2 流。**适用:** 目标讲 HTTP/2; 请求 body 不超 MTU(TLS 开销后约 1400 字节); 需要 N ≤ 30。
- **多连接各一流**(老式并行 HTTP/1.1): N 条 TCP 连接, 每连接一个请求。**适用:** 目标不讲 HTTP/2 或 body 大于 MTU。竞争窗口显著变宽(5–50 ms TCP 握手离散)——仅对慢服务器可行。
- **多连接多流**(Flatt 首序列同步, 2024): N 条 TCP 连接各承载 M 个流, 总计 N×M 个请求。利用多连接间同步的 TCP 首序列号, 让所有包落在服务端同一处理窗口。**适用:** 需要 N > 30(如在 5 次限流窗口内爆破 6 位 PIN——Flatt 用 IP 分片加同步 SEQ 号在 166 ms 内打出 10,000 个请求)。

#### Turbo Intruder `Engine.BURP2` 模板——逐行解析

```python
def queueRequests(target, wordlists):
    # 1. Engine.BURP2 = HTTP/2 single-packet engine; provides the last-byte-sync primitive.
    engine = RequestEngine(
        endpoint=target.endpoint,
        concurrentConnections=1,          # 2. One TCP connection, multiplexing all streams.
        requestsPerConnection=100,        # 3. Up to 100 concurrent H2 streams. >30 needs Flatt-extension.
        engine=Engine.BURP2,              # 4. THE critical line — selects the single-packet engine.
        pipeline=False,                   # 5. Pipelining is for HTTP/1.1; irrelevant on H2.
    )

    # 6. Build N requests. Each is identical here — racing the same endpoint.
    #    For PIN brute-force, vary the body across requests.
    for i in range(30):
        engine.queue(target.req)

    # 7. openGate(...).complete(...) is the API call that performs last-byte-sync:
    #    - Buffer all 30 requests up to "last byte not sent"
    #    - Release all final bytes in a single TCP write
    #    - openGate returns immediately; complete waits for all responses.
    engine.openGate("race1")
    engine.complete(timeout=10)
```

`Engine.BURP2` 引擎承担全部重活。幕后机制:
- 每个 `engine.queue(req)` 向连接的发送缓冲追加一个 HEADERS 帧, 但扣留最后一个 DATA 帧字节。
- `openGate("race1")` 阻塞至全部 30 个缓冲完毕, 然后执行一次包含 30 个 × 1 字节、置 END_STREAM 的 DATA 帧的 `socket.send(...)`。全部 30 个在一个 IP 包内上线(前提 < MTU)。
- `complete(timeout=10)` 收集响应与耗时。

检查每个响应对象: `req.code`、`req.length`、`req.time`。当至少 2 个请求返回了逻辑上互斥的成功(如核销上限为 1 时两次优惠券应用都成功), 竞争即"获胜"。

#### Flatt 首序列同步扩展(N > 30 时)

Kettle 原版单包受 MTU + TLS 记录限制, 上限约 N=30。Flatt Security 的 RyotaK 于 2024 年 8 月发布扩展:

- 利用 IP 分片: IP 层的一个"逻辑"包可拆分为多个物理 IP 分片。
- 以锁步方式完成 TLS 握手并对齐 SYN/SYN-ACK 时序, 强制多条连接的 TCP SEQ 号同步。
- 结果: 166 ms 内向服务端送达 10,000 个并发请求, 全部落在服务端自视为原子的限流窗口内。

用例: 在每窗口 5 次的限制内爆破 6 位 PIN(最多 10^6 个候选)。没有首序列同步需要约 200,000 个窗口; 有它只需约 100 个窗口。

实现: [flatt.tech/research/posts/beyond-the-limit-...](https://flatt.tech/research/posts/beyond-the-limit-expanding-single-packet-race-condition-with-first-sequence-sync/) 含可运行 PoC。

#### 操作手册(何时用何工具)

| 场景 | 工具/变体 |
|---|---|
| 现代 HTTPS 目标, ALPN 通告 `h2`, body < 1400 字节, 需 N ≤ 30 | Turbo Intruder `Engine.BURP2` 单包——**默认** |
| 同上但 body > MTU | 多连接 HTTP/2; 窗口估算放宽约 5 ms |
| 目标仅讲 HTTP/1.1(无 h2 ALPN) | `curl --next` 并行流水线; 竞态窗口宽; 仅对慢服务器可行 |
| 需 N > 30(限流窗口内 PIN 爆破、OTP 耗尽) | Flatt 首序列同步扩展; 按公开研究文章手工实现 |
| 前端 h2、后端 h1(CDN+源站) | h2.cl 走私变体——配合 HTTP 请求走私技术 |
| 单端点快速复现测试 | `curl --next --next --next --next`(4 连发并行 HTTP/1.1)——窗口宽但零准备 |

#### 反模式

- **不要仅凭 Burp Repeater "Send group in parallel" 模式下两次近乎同时的成功就宣称"竞态条件"**——该模式是毫秒级离散的 HTTP/1.1 流水线, 不是单包。这种证据会被降级处理。
- **高价值竞争论断不要缺少 Wireshark 确认。** 最有说服力的交付物: Turbo Intruder 发射的 PoC 视频 + Wireshark 抓包显示全部 N 个 END_STREAM 帧同处一个 TCP 段 + N 个本应互斥却都成功的响应。
- **不要对真正无竞争的端点(带行级锁和事务的端点)使用单包攻击。** 窗口估算步骤就是为了在花 2 小时搭 PoC 之前过滤掉它们。

### 实战影响案例

#### 案例 1: 社交平台投票操纵
某安全众测平台的"热门报告"功能允许点赞提升报告曝光度与研究员声誉分。用单条 HTTP/2 连接(单包攻击)对同一报告并发发送约 15 个点赞请求, 单账户可注册 10–15 票。这允许人为抬高报告排名、操纵研究员声誉分、扭曲平台的众包优先级体系——直接损害平台用于漏洞报告分诊的核心机制的公信力。

#### 案例 2: 大型社交网络——促销动作重复领取
某 Facebook 量级社交网络上, 促销或限次动作——如绑定手机号领取一次性安全积分、领取一次性奖励——可被并发并行请求竞争。攻击者竞争领取端点即可多次获得促销权益, 造成平台直接资金损失, 并允许规模化欺诈性累积平台货币或权益。以其用户体量, 补丁前的哪怕短暂窗口都意味着重大资金敞口。

#### 案例 3: 云基础设施服务商——资源配额绕过
某云主机服务商对免费档用户可创建的资源数(如主机实例、项目、API key)设限。配额检查与资源创建是非原子操作。以 20 个并发请求竞争创建端点, 攻击者绕过配额逻辑, 创建远超档位限额的资源。直接转化为未授权算力消耗、计费欺诈与基础设施滥用——同时损害服务商收入与合法用户的系统稳定性。

### 公开披露案例引用(补录 +9, 2016-2024)

以下真实、经核实的公开披露/协同披露案例扩展本技能。其中四例(#4、#11、#12 及附加参考)使用现代 **HTTP/2 单包攻击**(Kettle DEF CON 31, 2023; Flatt Security 扩展, 2024)——正是让当今大多数现代竞态利用可行的技术。

4. **GitLab — CVE-2022-4037 邮箱验证竞态(Kettle DEF CON 31 案例)** ([NVD](https://nvd.nist.gov/vuln/detail/CVE-2022-4037) · [PortSwigger Research](https://portswigger.net/research/smashing-the-state-machine))
    - 子类: 密码重置/改邮箱 token 竞态(邮箱验证上的 TOCTOU)
    - 单包 HTTP/2: **是** ——"Smashing the State Machine"旗舰案例
    - Payload: 两个并发 `POST /-/profile` 请求把邮箱改为两个不同地址; 发给地址 A 的验证 token 对地址 B 生效, 因为状态转移非原子
    - 根因: Devise(Rails 认证)在新邮箱持久化前生成确认 token; 并发更新导致 token 投递错路
    - 年份: 2022(2023 披露), CVSS 6.4, 修复版本 15.7.2 / 15.6.4 / 15.5.7

5. **Worldcoin (Tools for Humanity) — World ID 动作验证竞态** ([Medium 披露文章](https://medium.com/@gonzo-hacks/the-fast-and-the-curious-finding-a-race-condition-in-worldcoin-621c89bfbd61))
    - 子类: 投票/点赞通胀(一人一动作强制绕过)
    - Payload: 经 Burp "Send in Parallel" 对验证端点发约 20 个并行请求
    - 根因: `canVerifyForAction` 追加进数组无数据库级锁; 修复新增 `nullifiers` 表用原子 UPSERT
    - 年份: 2023 —— 危害等级 high("一人一验证"完整性失效, 可规模化伪造动作验证)

6. **Stripe — 促销码超限核销** ([公开披露报告](https://hackerone.com/reports/1717650))
    - 子类: 优惠券双重核销
    - Payload: 创建核销上限 = 1 的 promo; 同一商户开两个支付链接标签页, 两边都应用优惠券, 同时点击支付 → 两次都成功
    - 根因: 核销计数在扣款之后递增, 与扣款非原子; `promotion_code.times_redeemed` 无行级锁
    - 年份: 2022 —— 危害: 促销资金超限流失

7. **Stripe — 手续费折扣多次核销** ([公开披露报告](https://hackerone.com/reports/1849626))
    - 子类: 钱包/余额双花(Connect 手续费折扣可反复核销)
    - Payload: 在一次性促销积分的已消费标志翻转前, 并行 POST 核销端点
    - 根因: 积分余额对象上的先检查后扣减非原子
    - 年份: 2023 —— 危害 high: 每次核销约 $600 平台手续费损失, 可反复利用

8. **Reverb.com — 礼品卡多次核销** ([公开披露报告](https://hackerone.com/reports/759247))
    - 子类: 优惠券双重核销(礼品卡)
    - Payload: 抓取 `POST /gift_cards/redeem` → 复制 N 份 → 并行发射 → 单卡入账 N 倍余额
    - 根因: 礼品卡消费标记写在余额入账之后, 核销读取无 `SELECT…FOR UPDATE`
    - 年份: 2019 —— 奠基性/被广泛引用的案例, 危害: 直接资金双花

9. **Cosmos / Starport 水龙头 — 双铸币竞态** ([公开披露报告](https://hackerone.com/reports/1438052))
    - 子类: 钱包/余额双花(加密水龙头代币发放)
    - Payload: 同时发多个 `/faucet/transfer` 请求; Go 的 `Transfer` 函数每请求执行两个改状态动作, 均非原子
    - 根因: 水龙头 handler 未按收款人加锁; transfer() 的读-改-写未串行化
    - 年份: 2022 —— CVSS 9.3(critical: 代币双铸)

10. **InnoGames — 邮箱激活竞态 → 无限钻石** ([公开披露报告](https://hackerone.com/reports/509629))
    - 子类: 推荐滥用倍增/账户创建竞态(一个激活 token → 多次"首次激活奖励")
    - Payload: 在 `token_used` 标志提交前, 用同一个一次性 token 竞争邮箱激活端点 → 每个获胜请求都发奖励
    - 根因: token 消费标志与奖励发放同事务, 但事务隔离级别过低(READ COMMITTED)
    - 年份: 2019 —— 危害: 虚拟经济通胀

11. **RyotaK / Flatt Security — "首序列同步" PIN 爆破(万请求单包扩展)** ([Flatt Security Research](https://flatt.tech/research/posts/beyond-the-limit-expanding-single-packet-race-condition-with-first-sequence-sync/))
    - 子类: 经竞争绕过限流 / MFA-OTP 校验竞态(5 次上限的 6 位 PIN)
    - 单包 HTTP/2: **是** —— 用 IP 分片加同步 TCP 首序列, 把 Kettle 单包从约 30 个请求扩展到 166 ms 内 10,000 个请求
    - Payload: 166 ms 内约 10,000 个并发 `POST /verify-pin` 请求, 各带不同的 4-6 位猜测, 全部落入同一限流窗口
    - 根因: 限流计数器按请求异步递增; "5 次尝试"闸门对整批读到的是过期计数
    - 年份: 2024 —— 现代单包攻击必读范例

12. **nopCommerce — CVE-2024-58248 礼品卡双重核销** ([NVD](https://nvd.nist.gov/vuln/detail/CVE-2024-58248))
    - 子类: 优惠券双重核销(电商结账 TOCTOU)
    - 单包 HTTP/2: **是** —— 单包攻击可稳定复现
    - Payload: 两个并行 `POST /checkout/PlaceOrder` 请求都应用同一礼品卡 → 两个订单都完成, 礼品卡余额只扣一次
    - 根因: 下单代码路径未对礼品卡余额行加锁 → 先检查后扣款非原子
    - 年份: 2024(4.80.0 之前版本)

### 关联技能与链路

- **api-logic** —— 竞态条件是一切业务逻辑状态机的"并发臂"。链路原语: 业务逻辑(优惠券/促销)+ 竞态单包攻击 → 优惠券核销 N 次 → 直接资金损失。纯业务逻辑漏洞(无并发触发)归 api-logic。
- **auth-matrix** —— OTP 有效期窗口与重放防护是经典竞争目标。链路原语: 竞争 + MFA 校验端点 → 在有效窗口内提交 N 个并发校验绕过 OTP 过期; 密码重置/改邮箱/建户上的竞争可导致持久账户接管(换绑受害者邮箱 + 在其察觉前读走重置 token)。
- **api-mapping / api-replay** —— 钱包/余额/积分端点缺原子 UPDATE 即双花候选。链路原语: 竞争 + 缺原子更新 → 双花余额 → 提现 N 倍用户余额。
- h2.cl 多帧变体配合 HTTP 请求走私技术; 案例引用 #4、#11、#12 是单包攻击的规范范例(GitLab/Devise CVE-2022-4037、Flatt 万请求 PIN 爆破、nopCommerce CVE-2024-58248)。

## 证据要求

落账前必须三项全部确认(Gate 0 校验):

1. **攻击者现在能做什么?** 能否用截图或日志证明同一一次性动作成功了不止一次?(投票计数显示单用户 +2、积分余额显示双重入账、优惠券显示核销两次)
2. **被害方损失了什么?** 有具体可量化的危害吗? 资金损失(超额发放积分)、完整性损失(被操纵的排名/票数)、安全损失(超出授权的访问)?"计数器涨了两次"只有在该计数有真实价值时才成立。
3. **从零起 10 分钟内可复现吗?** 能否写一个 20 行脚本, 对全新测试账户运行, 至少 3/5 次尝试稳定复现重复效果? 若依赖无法可靠控制的完美时序, 可利用性论断不成立。

证据清单:
- N 个本应互斥却都成功的原始响应片段(≥2 个 2xx + 重复成功消息)
- 实际状态变更证据: 竞争后余额/票数/核销状态的截图或回读响应(写后必读回)
- 单包攻击主张: Wireshark/tcpdump 抓包, 证明全部 N 个 END_STREAM 帧同处一个 TLS 记录、一个 TCP 段; Burp Repeater 并行模式(毫秒级抖动流水线)不构成单包证据
- 复现参数: 并行数 N、轮次、5 次独立尝试的成功率、窗口估算数据(T_single/T_par)

## 停止条件

- 2-3 次成功演示即停, 不做规模化滥用(不重复套现、不刷满余额)——证明即停。
- 窗口估算显示服务端串行处理(带行级锁/事务的端点)且单包无增益 → 该端点记为不可竞争, 转下一目标, 不浪费 PoC 工时。
- 递减并行度测试(5/3/2 发)完成后即停止探测, 不继续压测服务器负载。
- 撞上数据库约束报错(最后一道防线生效)= 竞争未成立, 不作为可利用证据上报。
- 只用测试账户与测试订单执行; 触及真实资金/生产数据即停。

## 落账

report_vulnerability 的 severity 判定:

- **critical**: 加密代币/铸币双花(CVSS ≥ 9, 如 Cosmos 水龙头)、可规模化反复套现的直接资金损失(礼品卡/钱包/促销积分多次核销且可提现)、密码重置/改邮箱竞态导致持久账户接管。
- **high**: 单人多次突破"一人一次"强制(World ID 类)、MFA-OTP 在限流窗口内被并发校验绕过(Flatt PIN 爆破类)、限流被万请求单包整体击穿、账户配额绕过导致未授权资源消耗。
- **medium**: 影响有限的完整性操纵(单点投票/点赞通胀且无资金转化)、需苛刻条件才可复现的部分履约。
- **low**: 仅观察到计数器异常但无真实价值损失、复现率 < 3/5 的边缘案例。

判定要点: 危害 = 资金损失/完整性损失/越权访问三选一且可量化; "计数器涨了两次"本身不构成危害。附复现脚本与成功率数据。

相关 publish_intel:
- 竞争窗口特征与端点模式(单次成功+多次成功的响应时序指纹、URL 模式表命中)→ 标记 `race-window`
- 目标技术栈信号(Rails 无锁/Redis 计数器/微服务 TOCTOU)→ 标记 `api-surface`
- 单包可用性结论(h2 ALPN、MTU 内 body、worker 池并行分发)→ 供 api-replay 回归复用
