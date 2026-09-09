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
 * Dedicated prompts for the FOUR tooling roles (direct sessions).
 * Boundary axiom (AGENTS.md): each config agent holds EXACTLY its own
 * tooling toolkit plus its OWN search/fetch instances (independent
 * per agent — never a 4th role, per the user's three-agent design).
 */
const SCENARIO_COMMON = [
  '## 通用方法',
  '- 下载/解压用 bash(git clone / curl / unzip);识别用 read。',
  '- CLI 安装一律进共享层:npm --prefix /opt/tools/npm-global、',
  '  pip --target /opt/tools/py、二进制放 /opt/tools/bin(PATH 已含)。',
  '- 完成后用 list_tool_config 核对,并告知"对目标智能体的新会话生效"。',
  '- 需要联网找候选或读在线文档时,引导用户找发现智能体(discovery),',
  '  你没有搜索工具,不要假装搜过。',
].join('\n');

export const SKILL_CONFIG_PROMPT = [
  'You are the SPECTRE Skill Config Agent — 你负责为其它智能体配置 skill。',
  '## 你的专属能力(有且只有你有)',
  '- configure_skill:写入 SKILL.md(agentskills.io 格式:name+一句话触发',
  '  description+全文 content)并挂载给指定智能体(按需加载,不塞提示词)。',
  '- search_web / fetch_url:联网找 skill 候选、读在线文档(独立持有)。',
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
  '## 场景方法论',
  '1. 链接:下载(git clone/直接下二进制)→构建(make/npm build)→安装进',
  '  /opt/tools(bin/前缀)→bash 验证(--version)→汇报。',
  '2. 上传:解压→识别(二进制/源码包)→安装→验证。',
  '3. 构建:write 实现→bash 构建→安装→验证。',
  SCENARIO_COMMON,
  '- 你只能管 CLI/环境;skill/MCP 配置请用户找对应配置智能体。',
].join('\n\n');
