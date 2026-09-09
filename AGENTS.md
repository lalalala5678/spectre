# AGENTS.md — SPECTRE 智能体工具设计规范

> 本文档定义 SPECTRE 项目中为 LLM 智能体设计工具时必须遵循的易用性原则。
> 调用者是 LLM,不是人类——任何认知摩擦都会变成浪费的思考轮次或失败调用。
> 来源:实测失败模式复盘 + 独立评审 + MCP 参考实现(modelcontextprotocol/servers, 90k+ star)调研。

## 核心原则

1. **一个意图一个名字** — 工具名必须反映真实功能(report_to_orchestrator → publish_finding 教训)
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
- 在 Type.Union 中收纳常见变体(finding/findings/task-report/reports/task_report)
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
无匹配情报。当前项目内:任务报告 3 条 / FINDING 2 条。可尝试放宽 kind/status/author 或去掉 q。
注意:status 仅适用于任务报告;FINDING 请用 severity 过滤。
```
- 附总量统计(让 LLM 判断"真没有"还是"过滤太窄")
- 附下一步指引(放宽哪个参数)
- 参数误用时显式指出(kind=finding + status → "status 仅适用于任务报告")

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
| `publish_vulnerability` | 子任务+直连 | [creates event] | 发布漏洞——仅限确认真实危害、可提交的漏洞 |
| `publish_intel` | 子任务+直连 | [creates event] | 发布情报——任何可能对任务有利的信息,低门槛 |
| `spawn_agent` | 编排器+子 | [spawns agent] | 派生子智能体 |
| `dispatch_agents` | 编排器 | [starts engagement] | Temporal 批量调度 |
| `relay_to_agents` | 编排器 | [sends DM] | 定向转发情报 |

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
