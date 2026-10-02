# SPECTRE 架构设计

> 自主渗透测试作战控制台。仓库任意目录部署(见 deploy/README「快速开始」),面向单台主机。
> 阶段状态:基座(全部子智能体 = 同一套基础 pi,零定制);定制化是规划中的扩展点。

## 1. 系统总览

```
浏览器
  │ https://<你的域名或IP>/spectre/
  ▼
caddy (:443, /spectre*) ── 真实 TLS,唯一公网入口
  ▼
gateway (Python :8081, 仅 127.0.0.1)
  │  认证(scrypt+会话) → 静态 dist / API 反代(含 SSE 流式)
  ├── /spectre/api/* ──► agent-runtime (Node :8090, 仅 127.0.0.1)
  │                        │  pi 会话池(pi-agent-core × 用户配置的 LLM)
  │                        │  消息总线 journal + SSE
  │                        │  Temporal client(启动编排)
  │                        ▼
  │                     temporal-dev (:7233, 仅 127.0.0.1)
  │                        ▲
  │                     worker (Node, task queue "spectre")
  │                        │  autoPwnWorkflow(父) → agentTaskWorkflow(子)×N
  │                        │  activities: createSession/promptAndWait/
  │                        │              steerSession/busEmit
  └── /spectre/ 静态   ▲   │
                       └───┴── HTTP + X-Internal-Token ──► agent-runtime
```

## 2. 目录结构(目标状态)

```
<仓库根>/
├── docs/                          # 本文档、ADR、runbook
│   └── ARCHITECTURE.md
│
├── console/                       # 前端 SPA(React+Vite,base=./ 适配 /spectre/ 挂载)
│   ├── src/
│   │   ├── api/                   # 后端客户端:fetch 封装 + SSE 订阅(client.ts)
│   │   ├── components/            # 通用组件(Sidebar/Topbar/ui)
│   │   ├── components/session/    # 会话视图(消息流/事件流/聊天输入)
│   │   ├── components/agent/      # agent 配置页签组件(CS44-F17 拆分)
│   │   ├── pages/                 # 路由页(AutoPwn/BusView/Audit/…)
│   │   ├── types/                 # 共享类型(RouteKey/AgentMeta 等活消费面)
│   │   └── utils/
│   ├── dist/                      # 构建产物(gateway 托管的唯一静态源)
│   └── package.json
│
├── gateway/                       # Python 认证网关(已拆包;tests/ 回归测试)
│   ├── spectre_gateway/
│   │   ├── __init__.py
│   │   ├── config.py              # 路径/超时/cookie 常量
│   │   ├── security.py            # scrypt 校验、会话存储、限速锁定、审计
│   │   ├── static_files.py        # dist 静态服务(防穿越、缓存头)
│   │   ├── session_store.py       # 会话持久化(JSON 落盘, 防抖写)
│   │   ├── proxy.py               # /spectre/api 反代(SSE 透传,read1 逐帧)
│   │   ├── pages.py               # 登录页模板
│   │   └── handler.py             # 路由分发
│   └── server.py                  # 入口(systemd 指向)
│
├── backend/                       # Node 侧(agent-runtime + worker)
│   ├── agent-runtime.mjs          # 入口:HTTP 服务装配
│   ├── worker.mjs                 # 入口:Temporal Worker 装配
│   ├── workflows.mjs              # autoPwnWorkflow / agentTaskWorkflow
│   ├── activities.mjs             # 9 个 activity(唯一出站副作用点)
│   ├── src/
│   │   ├── config.mjs             # .env 加载 + 冻结常量(唯一配置源)
│   │   ├── agents.mjs             # 智能体注册表(key/name/role)
│   │   ├── pi.mjs                 # pi 构建 + 消息归一化(base 配置)
│   │   ├── sessions.mjs           # SessionStore:pi 会话 + 事件 journal + SSE
│   │   ├── bus.mjs                # Bus:跨智能体消息 journal + SSE
│   │   ├── temporal.mjs           # Temporal client(启动/查询编排)
│   │   ├── routes.mjs             # HTTP 路由(公共 vs 内部令牌分离)
│   │   ├── http.mjs               # json/readJson/sse/内部令牌工具
│   │   └── …/                     # 其余(settings/projects/persist/revision/tools/agent-settings/keyfiles/spawn-policy 等; 详 §3 行数表与 sandbox/ 十模块, CS62-#7: 显式省略制)
│   ├── agents/                    # 【扩展点】逐智能体深度定制
│   │   ├── _base/                 #   共享底座(SYSTEM.md/tools/skills)
│   │   ├── recon/                 #   每智能体:SYSTEM.md + tools.mjs + skills/
│   │   └── …/
│   ├── .env                       # 密钥(600):INTERNAL_TOKEN(LLM 已平台化——设置页配置)
│   └── package.json
│
├── deploy/                        # 运维物料
│   ├── systemd/                   # 单元文件 ×6
│   ├── setup.sh / setup-tls.sh    # 一键部署 + 对外 TLS 装配(小白默认路径)
│   ├── Caddyfile                  # TLS 反代手工样例(默认由 setup-tls 生成等效配置)
│   ├── oob-collector.py           # OOB TCP 收集器
│   └── tools-sync/skills-seed/fetch-jars/fetch-fingerprints/
│       fetch-wordlists/bootstrap 六脚本(前五=SPECTRE_DATA_DIR
│       生产路径守卫族(含 fetch-wordlists, 落数据根 tools/, 容器
│       内挂载为 /opt/tools); bootstrap=容器/宿主守卫)
│
└── (运行时数据,不在仓库)
    /etc/spectre-auth/             #   passwd(多用户 scrypt)
    /var/log/spectre-console/      #   auth.log(JSONL 审计)
    /var/lib/temporal-dev/         #   Temporal dev 数据库
```

## 3. 模块边界与依赖规则(硬约束)

| 规则 | 理由 |
|---|---|
| console 只经 `/spectre/api/*` 说话,不直连 runtime | 单一入口 = 单点认证与审计 |
| gateway 不解析业务,只做 认证→静态/反代 | 认证域与业务域隔离 |
| workflow 代码不 import runtime 内部模块 | worker 与 runtime 只通过 `runtime-client.mjs`(HTTP+令牌)交互,两服务独立部署/重启 |
| activities 是 workflow 唯一出站副作用点 | Temporal 可观测性(history 完整记录每次副作用) |
| `config.mjs` 是后端唯一配置源 | LLM 厂商在平台「设置」页换(R32D44 平台化); 端口等 = 改 `.env` 一处 |
| 智能体身份(agent impersonation)必须带 INTERNAL_TOKEN | 浏览器会话不能伪造 [DM] 注入 |
| 单一职责;行数软指引(tools(1090)/pi(1055)/sessions(1016)/routes(916)/agent-settings(768)/sandbox·tooling(784)/sandbox·container(557) 七文件属聚合已知例外, 拆分在 backlog) | 可读性/可维护性 |

## 4. 控制面 vs 数据面

- **控制面(Temporal)**:任务派发、跨智能体路由(公告/私信/共享)、engagement 生命周期、失败兜底。持久化在 Temporal history —— 进程崩溃任务图不丢。
- **数据面(runtime 直连)**:用户↔单个智能体的实时对话(prompt/steer)、token 级事件流(SSE)。低延迟,不进 workflow(避免每 token 一次 Temporal 事件)。
- 两面交汇点:消息总线 journal(runtime 内存 + SSE 重放)。后续接审计链时由 journal 落盘对账。

## 5. 服务拓扑(systemd)

| 单元 | 内容 | 端口 |
|---|---|---|
| caddy | TLS 终结 + /spectre* 路由 | 443(公网) |
| spectre-console | Python 网关 | 127.0.0.1:8081 |
| spectre-agent-runtime | pi 会话 + 总线 | 127.0.0.1:8090 |
| spectre-worker | Temporal worker | -(轮询) |
| temporal-dev | 编排引擎 + UI | 127.0.0.1:7233/7234 |
| spectre-oob | OOB 回调收集器(TCP, 带配额/限速) | 0.0.0.0:19999(OOB_PORT) |
| spectre-private-qa | 私有 QA 面板 | 127.0.0.1:8899 |

## 6. 已验证能力(基座,2026-09-07 全链路浏览器实测)

- 单智能体会话:点击侧栏智能体 → 复用/新建 pi 会话(顶栏切换器可选
  旧会话、「新任务」开新会话)→ 实时对话, 所配 LLM 流式回复经
  caddy→网关→runtime 三级 SSE 透传
- **AutoPwn = 单一对话框直连调度智能体**:`dispatch_agents` 工具启动
  Temporal 编排,orchestrator 自主拆解派发
- **双向消息互通**(子↔主控,子不直达子):
  - 子智能体中途 `publish_vulnerability` → 总线私信(intel)+
    [DM] 注入 orchestrator 会话(实测 2/2 送达)
  - orchestrator 判定后 `relay_to_agents` → 定向 DM 注入子会话
    (实测 4 次转发)
  - engagement 完成 → 自动 followUp 通知 orchestrator 产出汇总
- 右栏动态面板:子 Agent(engagement 子会话,运行中/结束,点击下钻
  到该子智能体视角)、漏洞 VULNS/情报 INTEL(总线共享事件,点击跳转来源会话)
- 对话体验:token 级流式渲染(delta 帧 + 尾气泡增量扩展,实测 227 帧/2.6s)、
  用户消息零重复(SSE 游标从 lastSeq 起,乐观渲染去重)、
  assistant 回复 Markdown 渲染(react-markdown + GFM 表格/代码/列表)
- thinking 流式:thinking_delta 帧先于正文帧到达(实测 43 帧思考 + 406 帧正文),
  流式期橙色展开面板,完成后折叠为「思考过程」
- followUp 竞态修复:忙判用 pi 的 isStreaming + 失败回退队列,
  「already processing」错误不再外泄(用户原始路径回归通过)
- 网关 SSE 修复:反代必须用 `read1()` 逐帧转发(chunked 流不能用
  缓冲式 read,否则 SSE 帧被攒住;头/体早断均已 BrokenPipe 守卫)

## 6.5 工具配置三智能体(2026-09-10 落地,独立审计复核)

恰好三个配置智能体,不许第四个(用户铁律,AGENTS.md 同步记载):

|agentKey|专属工具(有且只有)|嵌入界面|
|---|---|---|
|skill-config|configure_skill + delete_skill + wake_agent + list_tool_config + search_web/fetch_url(独立实例)|Skill 管理页右栏|
|mcp-config|configure_mcp + remove_mcp_server + wake_agent + test_mcp_server + list_tool_config + search_web/fetch_url|MCP Server 页右栏|
|cli-config|uninstall_cli + wake_agent + list_tool_config + search_web/fetch_url|CLI 工具页右栏|

> CS20-4 勘误: wake_agent 仅配置三键持有(AGENTS.md:103 同口径); CS19-6
> 曾误记为"编排器+子"持有——编排器与业务 agent 的工具面只有官方四件
> +业务工具, 无 wake_agent。

- **边界**:业务智能体(recon/nday/调度等)零配置工具;配置智能体的
  systemPrompt 不拼业务 TOOLS_GUIDE(纯净提示词,只有自身动态工具清单);
  bash/read/write/edit 由 mount 层统一拼给所有会话(官方四件,非配置工具)
- **配置≠持有**:挂载边界=配置的 agents 字段/skill 目录;配置智能体自身
  零挂载(运行时数据核验:/var/lib/spectre/skills 仅 api/nday/recon)
- **四场景**(链接/上传/搜索发现/从零构建)由各配置智能体用
  配置工具+官方四件+自有搜索实例完成,零硬编码流程

## 6.9 资产测绘第一性原则(2026-09-11 定,不可覆盖)

> **完美地完成目标是唯一的最高优先级,不可被任何情况覆盖**——痕迹最小化、轻探测偏好、资源节约、时间窗口、API 配额等一切工程约束与之冲突时,约束让位。唯一例外是范围合规:越界不属于"完成任务",是事故,永远 fail。在此前提下尽可能降低对目标的痕迹;被动是第一动作不是天花板,探测阶梯为"同等信息增益取最轻"。

权威全文:`docs/recon-agent-design.md` §0。该原则必须同步出现于 recon 系统提示词、benchmark 评分器、recon 技能文档卷首。

## 7. 已知限制与后续路线

1. ~~会话内存态~~ 已解决: WAL append-only 重放(agent-runtime 启动恢复全部会话/bus/项目)
2. **智能体零定制**:逐智能体定制在 backend/src/agents.mjs 注册表+sessions.mjs 提示词层接入(无 backend/agents/ 目录)
3. ~~无工具、无沙箱~~ 已解决: sandbox/ 十模块(local/docker 双驱动 ExecutionEnv)+ tools.mjs 工具面
4. **审计链未接 Merkle**:auth.log 已有,业务事件(journal)待对账入链
5. **Temporal dev server**:单机开发态;生产需换正式集群 + PostgreSQL
