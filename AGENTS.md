# AGENTS.md — SPECTRE 智能体工具设计规范

> 本文档定义 SPECTRE 项目中为 LLM 智能体设计工具时必须遵循的易用性原则。
> 调用者是 LLM,不是人类——任何认知摩擦都会变成浪费的思考轮次或失败调用。
> 来源:实测失败模式复盘 + 独立评审 + MCP 参考实现(modelcontextprotocol/servers, 90k+ star)调研。

## 核心原则

1. **一个意图一个名字** — 工具名必须反映真实功能(report_to_orchestrator → publish_vulnerability 教训(彻底更名不留别名,历史 WAL 用 entryKind 归一))
2. **宁可不拒,拒则短痛** — 有合理默认值时绝不硬拒;必须拒时错误信息极简、可行动
3. **静默截断是 bug** — LLM 面向的消息体截断必须附显式标记与补全手段
4. **空结果必须有诊断信息** — 面对无解释的空,LLM 倾向原样重试
5. **大小写与变体宽容** — 枚举值在 execute 入口统一归一化,不依赖 LLM 精确拼写

## Schema 规范

### 字段命名
- 全小写,单词,无连字符/下划线优先(`status` 而非 `taskStatus`)
- 枚举值全小写(`success/partial/failed/no-result`、`info/low/medium/high/critical`)
- 布尔值用肯定式(`dryRun` 而非 `noRealRun`)

### 必填 vs 可选
- **必填**:模型经常遗漏的字段改为 Optional + 服务端推断兜底,回执注明推断值
- **推断规则优先级**:失败信号 > 部分完成 > 非空成功 > 兜底值(选误伤最小的)
- 推断结果必须标注"(由系统推断为 X,如有误请再次提交修正)" — append-only 数据无更正机制

### 枚举值
- 在 Type.Union 中收纳常见变体(vulnerability/vuln/task-report/reports/intel/notes/task_report)
- execute 入口统一 `toLowerCase()` / `toUpperCase()` 后再匹配
- 描述里列出全部合法值

### 参数描述
- **做什么 → 何时用 → 参数引导 → 限制** 四段式
- 首词标注副作用:`[read-only]` / `[creates event]` / `[side-effects: spawns agent]` 等
- 不要用指代不明的词(如 "receipts" — LLM 可能误解为别的操作)

## 输出规范

### 截断标记
```
(正文 400/2380 字符,传 seq=N 取全文)
```
- 每条截断必须附带:已显示长度 / 总长度 + 补全手段(seq 参数)
- 总输出超限时用 clipMarked 追加标记

### 空结果诊断
```
无匹配条目。当前项目内:任务报告 3 条 / 漏洞 2 条 / 情报 1 条。可尝试放宽 kind/status/author 或去掉 q。
注意:status 仅适用于任务报告;漏洞请用 severity 过滤。
```
- 附总量统计(让 LLM 判断"真没有"还是"过滤太窄")
- 附下一步指引(放宽哪个参数)
- 参数误用时显式指出(kind=vulnerability + status → "status 仅适用于任务报告")

### 总数披露
```
匹配 15 条,显示最新 5 条(可用 seq 取单条全文)(新→旧,库内最新 seq=25):
```
- 显示数 ≤ limit 但总数必须真实 — LLM 用它判断"是否全部完成"的态势

## 工具生命周期

### 更名
- 注册旧名为废弃别名(MCP filesystem 的 read_file/read_text_file 模式)
- 别名描述首句 `DEPRECATED: Use <new_name> instead.`
- 保留一个版本后移除
- 全仓 grep 引用一次同步(提示词/注释/文档/双胞胎常量)

### 新增工具
- 前端零工作:通用时间线自动渲染任何工具的调用与结果
- 描述首词加副作用标签
- 有默认值的参数标 Optional + default 描述
- 枚举值收纳常见变体 + execute 归一化

## 重复定义防护

- 逐字重复 ≥20 行的工具定义提取为共享工厂(如 buildSpawnAgentTool)
- 双胞胎常量(如 REPORT_NUDGE_TEXT)改名时必须全仓一次性对齐

## 当前工具清单

| 工具 | 会话类型 | 副作用 | 说明 |
|---|---|---|---|
| `query_intel` | 全部 | [read-only] | 查询项目条目(kind=vulnerability/intel/task-report) |
| `read_session` | 全部 | [read-only] | 按 sessionId/payloadRef 读源会话消息 |
| `submit_task_report` | 全部 | [creates event] | 提交任务报告(status 可选+推断;vulns 字段引用漏洞标题) |
| `report_vulnerability` | 子任务+非report直连 | [runs writer; synchronous] | 一句话上报漏洞线索——报告agent 读发现者会话上下文、验证后落账或驳回(回执判定) |
| `revise_entry` | 全部(writer 全类型;其它仅情报/任务报告) | [creates event] | 修订条目——append-only 修订链(revises+revision.n),现行版=最新修订;漏洞仅 writer 可改 |
| `request_vulnerability_revision` | 子任务+非report直连 | [runs writer; synchronous] | 漏洞修订申请——writer 审核必要性+正确性后落账或驳回(回执判定) |
| `publish_vulnerability` | 仅report会话(撰写agent) | [creates event] | 漏洞落账唯一入口——由报告agent持有;带 payloadRef+requester 溯源 |
| `publish_intel` | 子任务+直连 | [creates event] | 发布情报——任何可能对任务有利的信息,低门槛 |
| `spawn_agent` | 编排器+子 | [spawns agent] | 派生子智能体 |
| `dispatch_agents` | 编排器 | [starts engagement] | Temporal 批量调度 |
| `relay_to_agents` | 编排器 | [sends DM] | 定向转发情报 |
| `shell` | c2/persistence/postex/autopwn | [runs commands; side-effects] | C2 植入通道操作(注册/移交/执行/读文件/指纹) |
| `configure_skill` | 仅 skill-config | [writes config] | 给指定智能体挂载自定义技能 |
| `delete_skill` | 仅 skill-config | [destructive] | 卸载指定智能体的技能 |
| `configure_mcp` | 仅 mcp-config | [writes config] | 注册 MCP 服务器(http/stdio) |
| `remove_mcp_server` | 仅 mcp-config | [destructive] | 删除 MCP 服务器注册 |
| `test_mcp_server` | 仅 mcp-config | [read-only] | MCP 连通性探测 |
| `uninstall_cli` | 仅 cli-config | [destructive] | 卸载 CLI 工具 |
| `list_tool_config` | 配置三键 | [read-only] | 盘点共享层已装工具 |
| `wake_agent` | 编排器+子 | [spawns turn] | 唤醒空闲智能体一轮 |
| `search_web` | 全部(各持独立实例) | [read-only] | 联网搜索(provider 可配) |
| `fetch_url` | 全部(各持独立实例) | [read-only] | 抓取网页正文(带截断标记) |

## 历史教训(防止回归)

| 问题 | 根因 | 修复 | 防复发 |
|---|---|---|---|
| status 遗漏硬拒 | TypeBox Union 必填 + LLM 注意力稀释 | Optional + 推断兜底 | 新枚举字段必配默认值或推断 |
| 裸 JSON 信封显示 | normalizeMessage 直接 stringify 数组 | toolResultText 拆信封 | 新内容块类型须在前端时间线中渲染 |
| 悬空 vulns 引用 | 报告字段与漏洞实体无关联校验 | 模糊匹配警告 + 补救指引 | 新增跨实体引用字段须配校验 |
| 静默截断 400 字 | slice 无标记 | 标记 + seq 补全 | 新增截断处必须附标记与补全手段 |
| query_intel 重复调用 | 不完备计数 + 无诊断 | 总数披露 + 空结果诊断 | 空回执/截断处永远附诊断信息 |
| engagement 'autopwn-null' | null 模板字符串 | 条件表达式 + 跳过 signal | 字段拼接前检查 null |
| 系统注入伪装成用户发言 | followUp/steer 全部注入 role:'user',前端仅凭文本前缀分类 | 注入消息携带 source:'system'/'agent' 元数据,前端按 source 分类(旧数据用前缀回退) | 新增注入路径必须传 source;前端新增消息类型禁止只靠文本前缀识别 |

## 修订模型(append-only)

- 修订=新事件(revises: 原seq, revision: {n, reason, requestedBy, approvedBy}),永不改写历史
- 现行版=修订链上 revision.n 最大者;query_intel 与前端面板同语义折叠
- 权限:情报/任务报告任意 agent 可改(reason 留审计);漏洞仅 writer(申请-审核制);用户直编=终审
- 用户界面:详情页对话框(→报告agent)与直接编辑表单(→人工落账)双路径

## 工具配置三智能体(skill-config/mcp-config/cli-config)设计公理

- **有且只有**(用户铁律):配置 skill 的工具与提示词,有且只有 skill-config 有;MCP 同理 mcp-config;CLI 同理 cli-config。业务智能体(recon/nday/调度等)永不持有任何配置工具,也不受配置智能体提示词/skill 污染
- **共享工具→各持独立实例**(用户铁律):多智能体都需要的能力(如联网搜索),不是共享一份、更不是新造角色——每个智能体独立持有自己的工具实例。工具配置域=恰好三个智能体,不许第四个
- **配置≠持有**:配置智能体给指定智能体配置 skill/MCP;加载边界=配置的 agents 字段/skill 目录——它在物理上不持有被管理的工具(与"发现者不写漏洞"同源)
- **CLI=环境级**:装到 /opt/tools(PATH 已含),所有智能体共享;优先 npm --prefix /opt/tools/npm-global、pip --target /opt/tools/py
- **搜索=能力协商**:垂直通道(MCP registry/GitHub/包管理器)零 key 一等公民;通用 web 搜索可选 provider(默认 none——开源零绑定),未配置时如实声明,绝不假装搜索过
- **四场景零硬编码流程**:链接/上传/发现/构建全部由提示词方法论+工具组合涌现

## 沙箱与工具体系(官方优先原则)

- **不改 pi 框架**:优先使用 pi-agent-core 官方机制;自建仅限官方空缺处
- **ExecutionEnv 驱动抽象**(官方接口,自建实现):local(零依赖)/docker(单长寿命容器+bind mount)——官方 bash/read/write/edit 工具跑在 env 上,沙箱化 env 即沙箱化全部官方工具
- **项目工作目录**:/workspace/<wsId>(跨项目可读=特性);CLI 共享层 /opt/tools 装一次全员可用
- **Skill=官方 agentskills.io 格式**:loadSkills 从 per-agent 目录挂载,formatSkillsForSystemPrompt 生成索引注入,模型按需 read 全文(动态加载,非全量 prompt 注入)
- **MCP 双传输**:远程 http(用户自建机器直连,streamable-HTTP)与 stdio(host/sandbox 进程);会话创建时快照合并进工具面;配置存储 API 化(为未来 MCP 配置 agent 预留)
- 官方契约对齐点:FileError 码表(not_found/permission_denied/…)、ShellOutputView 平铺形状、TruncationResult 字段、FileInfo.kind/mtimeMs——适配层逐一对齐,勿凭记忆
