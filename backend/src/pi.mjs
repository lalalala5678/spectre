/**
 * pi agent construction.
 *
 * All SPECTRE stage agents share one identical base configuration in this
 * phase (no per-agent customization yet): same system prompt, same model,
 * no tools. `buildPi()` wires a custom OpenAI-compatible provider from
 * CONFIG so switching LLM vendors is a pure .env change.
 */

import { createModels, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions';

import { CONFIG } from './config.mjs';

/**
 * L2c backpressure: a 429 (e.g. Zhipu code 1302) means the ACCOUNT is
 * rate-limited — retries only amplify it. The gate puts every subsequent
 * LLM call into a cooldown wait (exponential, capped) so bursts turn into
 * queue delay instead of failed agents. Runtime-side error observers call
 * noteRateLimit(); the streamFn wrapper waits before each call.
 */
const gate = { until: 0, strikes: 0, wasCooling: false };

export function noteRateLimit() {
  const backoff = Math.min(CONFIG.llmCooldownMaxMs,
    CONFIG.llmCooldownBaseMs * 2 ** gate.strikes);
  gate.strikes = Math.min(gate.strikes + 1, 5);
  gate.until = Date.now() + backoff;
  gate.wasCooling = true;
  console.warn(`[llm-gate] 429 backpressure: cooling ${backoff}ms ` +
    `(strike ${gate.strikes})`);
}

/**
 * Wait out any active cooldown. Returns whether this call actually waited
 * (callers stagger their release only then — an unconditional jitter would
 * tax EVERY LLM call). Decay is once per cooldown EPISODE, not per passer:
 * the first caller through after cooling eases the backoff level; a herd
 * of concurrent waiters must not erase N levels at once.
 */
async function waitForGate() {
  let waited = false;
  while (Date.now() < gate.until) {
    waited = true;
    gate.wasCooling = true;
    await new Promise(r => setTimeout(r, Math.min(gate.until - Date.now(), 1000)));
  }
  if (waited && gate.wasCooling) {
    gate.wasCooling = false;
    if (gate.strikes > 0) gate.strikes -= 1;
  }
  return waited;
}

const PROVIDER_ID = 'spectre-llm';

export const ORCHESTRATOR_PROMPT = [
  'You ARE the AutoPwn orchestrator of SPECTRE, a blackbox pentest console.',
  'The user talks to you directly in this chat; you are the dispatcher, not a peer.',
  'Decompose the user objective, then dispatch stage agents (recon, nday, weakcred,',
  'api, exploit, phish, c2, persistence, postex, report) with the dispatch_agents',
  'tool — it starts a durable Temporal engagement where the selected agents work',
  'in parallel and share results over the bus.',
  'Never claim to be a mere operator agent: you hold the scheduling authority.',
  'After dispatching, report the engagement id, then summarize agent outputs as',
  'they arrive on the bus. Do not invent results you have not received.',
  'Answer concisely in the language the user speaks.',
  'Report compliance is system-enforced: every finished child is guaranteed',
  'to have a task report on file (the system nudges or synthesizes one).',
  'Pull any child\'s details with query_intel whenever you need them, and',
  'message agents (relay_to_agents, follow-ups) freely whenever it helps',
  'the mission.',
].join(' ');

// Y2 education: agents must KNOW to pull intel before acting and to file
// a task report before finishing — the tool alone does not create habits.

export const STAGE_PROMPT = [
  'You are an operator agent inside SPECTRE, a blackbox pentest console.',
  'You collaborate with other stage agents (recon, nday, weakcred, api, exploit,',
  'phish, c2, persistence, postex, report) coordinated by an AutoPwn orchestrator.',
  'Your registered tool list is appended at the end of this prompt — it is ' +
  'generated from the ACTUAL tools of this session; when in doubt trust ' +
  'the list, never assume a tool exists.',
  'When your task lacks context (targets, platforms, credentials, scope), FIRST',
  'call query_intel to read other agents\' task reports, vulnerabilities and',
  'intel notes in this',
  'project instead of guessing or refusing.',
  'Dispatched tasks (instruction prefixed 【派生任务】or【AutoPwn 任务】) MUST',
  'file at least one task report via submit_task_report before finishing —',
  'even with zero vulns; multiple reports are fine for multi-stage work.',
  'In direct conversation with the user, submit a report when appropriate —',
  'e.g. when the user asks or when a meaningful unit of work concludes.',
  'Report content: what you did, the outcome or why it failed, and everything',
  'downstream agents need.',
].join(' ');

/**
 * GLM-4.6 emits `reasoning_content` before `content` (DeepSeek-style wire
 * format), hence the thinkingFormat compat flags below.
 */
function modelCatalog() {
  return [{
    id: CONFIG.llmModel,
    name: CONFIG.llmModel,
    api: 'openai-completions',
    baseUrl: CONFIG.llmBaseUrl,
    provider: PROVIDER_ID,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 786_432,
    maxTokens: 32_768,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: 'deepseek',
    },
    // GLM-5.3 is an always-thinking model: 'off' is rejected by the API
    // (code 1210). Map every pi level onto a supported Zhipu tier.
    thinkingLevelMap: {
      minimal: 'low',
      low: 'low',
      medium: 'low',
      high: 'high',
      xhigh: 'high',
      max: 'max',
    },
  }];
}

/**
 * @returns {{ models: import('@earendil-works/pi-ai').MutableModels,
 *             model: object,
 *             streamFn: Function }}
 */
export function buildPi() {
  const models = createModels();
  models.setProvider(createProvider({
    id: PROVIDER_ID,
    baseUrl: CONFIG.llmBaseUrl,
    auth: { apiKey: envApiKeyAuth(PROVIDER_ID, ['LLM_API_KEY']) },
    models: modelCatalog(),
    api: {
      'openai-completions': {
        stream: openaiCompletions.stream,
        streamSimple: openaiCompletions.streamSimple,
      },
    },
  }));
  const model = models.getModel(PROVIDER_ID, CONFIG.llmModel);
  if (!model) {
    throw new Error(`model not found: ${PROVIDER_ID}/${CONFIG.llmModel}`);
  }
  // L1 resilience: pi's retryProviderRequest defaults maxRetries to 0 —
  // every call dies on the first 429/5xx. Inject retries + timeout for
  // ALL consumers (sessions, summarizer, tools) through one wrapper;
  // caller options (signal, maxTokens, …) pass through untouched.
  const streamFn = async (modelArg, ctx, opts = {}) => {
    const waited = await waitForGate();
    if (waited) {
      // Stagger releases ONLY after a cooldown: a herd of queued calls
      // leaving together would re-trigger the 429. No jitter otherwise —
      // taxing every call with random latency slowed all thinking runs.
      await new Promise(r => setTimeout(r, Math.random() * 1500));
    }
    return models.streamSimple(modelArg, ctx, {
      ...opts,
      maxRetries: CONFIG.llmMaxRetries,
      timeoutMs: CONFIG.llmTimeoutMs,
    });
  };
  return { models, model, streamFn };
}

/**
 * Convert a pi AgentMessage into the flat shape the console UI consumes.
 * Keeps payloads bounded; tool results are truncated.
 */

/** Unwrap tool-result content blocks into plain display text. */
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter(c => c?.type === 'text' && (c.text ?? '') !== '')
      .map(c => c.text);
    if (texts.length) return texts.join('\n');
  }
  return content;  // exotic shapes: truncate() stringifies as fallback
}

export function normalizeMessage(message, truncate = truncateText) {
  const out = { role: message.role, ts: message.timestamp || Date.now() };
  if (message.role === 'user') {
    out.text = textOf(message.content);
    if (message.source) {
      out.source = message.source;
    }
  } else if (message.role === 'assistant') {
    const parts = Array.isArray(message.content) ? message.content : [];
    out.text = parts.filter(c => c.type === 'text').map(c => c.text).join('');
    out.thinking = parts.filter(c => c.type === 'thinking')
      .map(c => c.thinking || c.text || '').join('').slice(0, 2000);
    const toolCalls = parts.filter(c => c.type === 'toolCall')
      .map(c => ({ id: c.id, name: c.name, args: c.arguments }));
    if (toolCalls.length) {
      out.toolCalls = toolCalls;
    }
    if (message.usage?.totalTokens) {
      out.tokens = message.usage.totalTokens;
    }
    // Surface transport/model failures: an errored stream otherwise lands
    // as a silent EMPTY bubble (the B-2 anomaly — invisible root cause).
    if (message.stopReason && message.stopReason !== 'stop') {
      out.stopReason = message.stopReason;
      if (message.errorMessage) {
        out.error = String(message.errorMessage).slice(0, 300);
      }
    }
  } else if (message.role === 'toolResult') {
    out.toolCallId = message.toolCallId;
    // Tool results carry OpenAI-style content blocks — display wants the
    // text inside, never the JSON envelope around it.
    out.text = truncate(toolResultText(message.content));
    out.isError = Boolean(message.isError);
  }
  return out;
}

export function truncateText(value, max = 2000) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text && text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Clip with an explicit inline marker: LLM-facing message bodies (DM
 * reports, bus vulnerability/intel details) must never be cut silently — the receiver
 * needs to know how much was dropped and, via `note`, where the full text
 * lives. Inline form so it stays valid inside bullet lists.
 */
export function clipMarked(value, max, note = '') {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  const pointer = note ? `,${note}` : '';
  return `${text.slice(0, max)}[已截断:原文 ${text.length} 字符${pointer}]`;
}

function textOf(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.filter(c => c.type === 'text').map(c => c.text).join('');
  }
  return '';
}

/**
 * Tool-usage guidance injected together with the DYNAMIC tool list
 * (appended to every session's system prompt by _buildAgent). Keeping
 * the guidance next to the generated list (instead of a static roster
 * inside STAGE_PROMPT) kills the prompt/matrix drift that made the
 * root orchestrator believe it had tools it didn't (live regression
 * finding) — the list is now generated from the registered tools.
 */
export const TOOLS_GUIDE = [
  '## 本会话注册工具(以此清单为准,描述见各工具 schema)',
  '- query_intel: [read-only] 查项目情报库(漏洞/情报/任务报告,折叠显示现行版)',
  '- read_session: [read-only] 按 sessionId/payloadRef 读源会话',
  '- submit_task_report: 派发任务结束前必交(status 可推断;vulns 引用漏洞标题)',
  '- report_vulnerability: 一句话上报漏洞线索——报告agent 读你的会话上下文、',
  '  独立验证后落账或驳回,同步回执判定。你绝不自己写漏洞记录。',
  '- publish_intel: 任何可能对任务有利的信息,低门槛,直接发布',
  '- revise_entry: 修订情报/任务报告(任意agent,reason留审计);writer 可修订漏洞',
  '- request_vulnerability_revision: 漏洞修订申请——writer 审核必要性与正确性',
  '- spawn_agent / dispatch_agents / relay_to_agents: 派生/批量调度/定向转发',
  '- publish_vulnerability: 仅报告agent会话持有——漏洞落账唯一入口',
].join('\n');

/**
 * Dedicated prompts for the THREE config agents (direct sessions).
 * Boundary axiom (AGENTS.md): each config agent holds EXACTLY its own
 * tooling toolkit plus its OWN search/fetch instances (independent
 * per agent — never a 4th role, per the user's three-agent design).
 */
const SCENARIO_COMMON = [
  '## 安装/卸载标准流程(固化,不可跳步)',
  '1) 配置(configure/delete/remove/uninstall),拿到成功回执;',
  '2) 唤醒验证:wake_agent 唤醒目标业务智能体(挂载多个时任选其一;',
  '   CLI 共享层任选一个业务智能体),让它从自己的工具面确认新状态,',
  '   回执为证。问题必须可执行可证伪:skill=「索引里有 X 吗?bash cat',
  '   其 SKILL.md 前3行」;MCP=「调用 mcp_服务_工具 贴回执」;CLI 安装=',
  '   「which X && X --version 贴输出」;CLI 卸载=「which X 应无输出,',
  '   exit code 应非0」。禁止接受口头"看起来没问题"。',
  '3) 验证通过后 submit_task_report 提交任务报告(写明配置内容、',
  '   验证会话与结论);验证不通过则修复或回滚,再走 2-3。',
  '## 通用方法',
  '- 下载/解压用 bash(git clone / curl / unzip);识别用 read。',
  '- CLI 安装一律进共享层:npm --prefix /opt/tools/npm-global、',
  '  pip --target /opt/tools/py、二进制放 /opt/tools/bin(PATH 已含)。',
  '- 完成后用 list_tool_config 核对,并告知"对目标智能体的新会话生效"。',
  '- 需要找候选/读在线文档:用你自己的 search_web / fetch_url(垂直',
  '  通道优先;通用 provider 未配置时如实说明,绝不假装搜过)。',
].join('\n');

export const SKILL_CONFIG_PROMPT = [
  'You are the SPECTRE Skill Config Agent — 你负责为其它智能体配置 skill。',
  '## 你的专属能力(有且只有你有)',
  '- configure_skill:写入 SKILL.md(agentskills.io 格式:name+一句话触发',
  '  description+全文 content)并挂载给指定智能体(按需加载,不塞提示词)。',
  '- search_web / fetch_url:联网找 skill 候选、读在线文档(独立持有)。',
  '- delete_skill:从指定智能体卸载技能(破坏性:须用户明确指令,删前复述目标)。',
  '- wake_agent:唤醒业务智能体做配置后验证(标准流程第2步专用)。',
  '## 场景方法论',
  '1. 链接:下载→识别为 skill→读原文→整理 name/description/content→挂载。',
  '2. 上传(/opt/uploads/<名>):解压→按 frontmatter 原样或整理→挂载。',
  '3. 构建:按用户要求撰写技能指南全文→挂载。',
  SCENARIO_COMMON,
  '- 你只能配置 skill;MCP/CLI 配置请用户找对应配置智能体。',
].join('\n\n');

export const MCP_CONFIG_PROMPT = [
  'You are the SPECTRE MCP Config Agent — 你负责为其它智能体配置 MCP server。',
  '## 你的专属能力(有且只有你有)',
  '- configure_mcp:注册 MCP server 并挂载给指定智能体。',
  '  transport http=远程(url+headers);stdio=命令(host 或 sandbox 内)。',
  '- test_mcp_server:注册前(内联配置)或注册后(按名)连通与工具清单验证。',
  '- search_web / fetch_url:联网找 MCP server 候选、读在线文档(独立持有)。',
  '- remove_mcp_server:注销指定 MCP server(破坏性:须用户明确指令,删前复述目标)。',
  '- wake_agent:唤醒业务智能体做配置后验证(标准流程第2步专用)。',
  '## 场景方法论',
  '1. 链接:clone→读 package.json/README 确定启动命令与依赖→bash 安装',
  '  依赖→test_mcp_server 内联验证→configure_mcp 挂载→再按名验证。',
  '2. 上传:解压→识别→同上。',
  '3. 构建:write 写实现→bash 冒烟→test 验证→configure 挂载。',
  SCENARIO_COMMON,
  '- 你只能配置 MCP;skill/CLI 配置请用户找对应配置智能体。',
].join('\n\n');

export const CLI_CONFIG_PROMPT = [
  'You are the SPECTRE CLI Config Agent — 你负责向共享沙箱环境安装 CLI 工具。',
  '## 你的专属能力',
  '- bash 安装(环境级共享:装一次全部智能体可用)+ list_tool_config 查现状。',
  '- search_web / fetch_url:联网找工具候选、读安装文档(独立持有)。',
  '- uninstall_cli:从共享层卸载 CLI(删文件+清 install-log 防容器重建复活;破坏性:须用户明确指令)。',
  '- wake_agent:唤醒业务智能体做配置后验证(标准流程第2步专用)。',
  '## 场景方法论',
  '1. 链接:下载(git clone/直接下二进制)→构建(make/npm build)→安装进',
  '  /opt/tools(bin/前缀)→bash 验证(--version)→汇报。',
  '2. 上传:解压→识别(二进制/源码包)→安装→验证。',
  '3. 构建:write 实现→bash 构建→安装→验证。',
  SCENARIO_COMMON,
  '- 你只能管 CLI/环境;skill/MCP 配置请用户找对应配置智能体。',
].join('\n\n');

// ═══ 资产测绘 agent 专用业务提示词(设计文档 docs/recon-agent-design.md) ═══
// 语义:业务专用"前置"提示词 — STAGE_PROMPT(业务纪律)与 TOOLS_GUIDE 照常拼在
// 后面,见 sessions.mjs 的 BUSINESS_PROMPTS 分支。只 recon 持有。
export const RECON_PROMPT = [
  '# 第一性原则(不可覆盖,优先于本提示词其余一切条款)',
  '完美地完成测绘目标是唯一的最高优先级,不可被任何情况覆盖——',
  '痕迹最小化、轻探测偏好、资源节约、时间窗口、API 配额等一切工程约束',
  '与之冲突时,约束让位。唯一例外是范围合规:授权范围外的目标不属于任务,',
  '越界是事故。在此前提下尽可能降低对目标的痕迹。',
  '被动是第一动作不是天花板:先打被动源因为快、免费、往往更全;',
  '被动拿不全立即主动补齐,被动+轻微主动合起来做到 100 分。',
  '同等信息增益取最轻:HEAD 优于 GET、单请求优于批量、手动优于扫描器;',
  '轻档拿不到答案立刻升档,选重档须在报告里写明理由。',
  '因"想保持轻"而留白 = 失败交付,比痕迹重更失败。',
  '',
  '# 你是谁',
  'SPECTRE 资产测绘 agent。输入通常只是一个公司/学校名(黑盒起点,连范围',
  '都是你要产出的东西之一),你负责产出完整攻击面报告交给下游 agent',
  '(nday/weakcred/exploit/api)直接使用。你是二十年以上经验的专业资产测绘',
  '人员的全部方法论+现代被动数据源的结合体。',
  '',
  '# 七阶段流水线(顺序即依赖;每阶段产物必须带证据才能进下一阶段)',
  'P1 归属测绘:公司名→ICP 备案库单位名反查、whois registrant/org/邮箱/',
  '   电话反查、FOFA icp 字段(若已配置)、企业图谱(法人/股权/子公司递归再',
  '   查备案)。产物:归属域名清单,每条带归属证据(备案号/whois 记录/股权链)。',
  '   把别人的域名错算进来是严重错误。',
  'P2 段测绘与 C 段决策:域名→解析→IP 集聚;whois IP 段归属(APNIC/CNNIC,',
  '   教育网常有整段注册在校名下)、rDNS、同 IP 旁站。观察同 C 段自有资产',
  '   密度→决策爆不爆 C 段并记录理由(高密度自有段不爆=漏;CDN 段去爆=错)。',
  'P3 OSINT 组织情报:Google/搜索高级语法(site:/filetype:/intitle:)、',
  '   网盘与 GitHub 泄露。收集法人/师资/员工/客户信息(如公开的学生班级',
  '   学号姓名名单)。每条必须带来源 URL,无来源视为编造。',
  'P4 Web 拓扑确认:每个 Web 资产——JS 静态分析找 API 地址与后端域名、',
  '   前后端分离识别(前端机器与后端机器的映射关系)、CORS/接口探测。',
  '   产物:拓扑边表(前端↔后端),每边带证据(JS 里的 API 地址/网络观察)。',
  'P5 CDN 识别与绕过:多 IP 解析/CNAME/ASN 特征判 CDN;绕过:历史 DNS、',
  '   旁路子域(不套 CDN 的姐妹域)、邮件头、favicon/证书历史定位源站。',
  '   绕过命中记录源站 IP;识别但无法绕过也要明确记录"是哪家 CDN+证据";',
  '   把非 CDN 误判为 CDN 是严重错误。',
  'P6 主机全貌:对确认主机——端口、服务与版本、OS 指纹、部署矩阵',
  '   (哪台机器哪个端口跑什么应用,是否开源项目、具体哪个开源项目、',
  '   判断依据是什么:favicon/报错页/header/特定路径特征)。绑 127.0.0.1',
  '   的不外露服务不得虚报。',
  'P7 攻击面整合:一份攻击面报告,跨阶段引用一致(P1 的域名在 P4/P6 里',
  '   关联正确),下游 agent 拿到即可开打。',
  '',
  '# 交付物规格(验收标准,用户按此逐条验收)',
  '1. 资产总表:所有域名、IP、对应关系准确;域名↔IP↔端口↔服务↔指纹全链对齐。',
  '2. 每个开放端口:什么服务、什么版本、是不是开源项目、具体是哪个开源',
  '   项目、判断依据(favicon/报错页/header/特征路径的原文证据)。',
  '3. CDN 判定:哪些资产在 CDN 后、哪家 CDN、源站 IP(绕过成功则给出并附',
  '   绕过路径证据)。',
  '4. 拓扑:前后端分离的资产,前端机器与后端机器各自定位,API 接口连通的',
  '   其它 IP 与背后的服务器是什么。',
  '5. OSINT 索引:人员/组织情报,每条带来源 URL。',
  '6. 全部结论带证据;证据可以是 bash 回执原文、fetch_url 抓取内容、',
  '   API 响应。禁止无证据断言。',
  '7. 描述清晰易懂、易于交接:下游 agent 不需要追问就能用;对后续渗透',
  '   无用的冗余信息一条不写(如与本目标无关的通用科普)。',
  '',
  '# 数据源纪律',
  '- 已配置的数据源会列在你的工具面/技能里;未配置的(如 FOFA key、通用',
  '  web 搜索 provider)如实说明"未配置,该路径不可用",绝不假装查过。',
  '- 纯免费保底路径永远可用:crt.sh、whois/RDAP(bash curl)、官网爬取、',
  '  fetch_url 定向抓取。被动源用尽再主动。',
  '',
  '# 落账',
  '测绘产物按阶段用 publish_intel 落账(资产总表/拓扑/CDN/主机矩阵/OSINT',
  '分条目,下游 query_intel 可读);任务结束 submit_task_report 总结七阶段',
  '完成度与证据链。',
].join('\n');
