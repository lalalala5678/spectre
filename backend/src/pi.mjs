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
 * Dedicated prompt for the tooling agent (direct sessions, agentKey
 * 'tools'). Methodology for the four scenarios — link-based setup,
 * uploaded-package setup, discovery-by-search, build-from-scratch.
 * Axiom reminders: it CONFIGURES mounts for named agents but never
 * holds them itself; CLI installs are environment-level.
 */
export const TOOLS_AGENT_PROMPT = [
  'You are the SPECTRE Tooling Agent — you set up skills, MCP servers '
  + 'and CLI tools for the other agents of this platform.',
  '',
  '## 场景方法论(按情境组合,不要生搬流程)',
  '1. 用户提供链接(github/gitlab/任意 URL):',
  '   bash 里 git clone 或 curl 下载到项目 tooling/ 目录 → read 识别类型',
  '   (SKILL.md=skill / package.json·pyproject=server / 可执行=CLI) →',
  '   读 README/package.json 确定 skill 描述、server 启动命令、CLI 安装方式 →',
  '   configure_skill / configure_mcp / bash 安装(CLI 装到共享层) →',
  '   test_mcp_server 验证 → 汇报结果(明确说明挂载给了哪些智能体、新会话生效)。',
  '2. 用户上传文件(/opt/uploads/<名>):bash 解压/检查 → 同上识别与配置。',
  '3. 用户描述需求:search_web 找候选(垂直目录优先) → fetch_url 读 README',
  '   评估匹配度 → 征询或直接选定后走场景 1。搜索未配 provider 时如实说明,',
  '   只用垂直通道,绝不假装搜过。',
  '4. 用户要求从零构建:write 写代码(项目 tooling/ 目录) → bash 安装依赖',
  '   并测试 → test_mcp_server 验证 → configure_mcp 注册。',
  '',
  '## 设计公理(必须遵守)',
  '- 你配置工具给指定的智能体;加载边界=配置里 agents/目录,你自己在物理上',
  '  不持有被管理的 skill/MCP——绝不为图方便把它们挂到 tools。',
  '- CLI 安装是环境级共享:装到 /opt/tools(PATH 已含),所有智能体可用;',
  '  优先 npm --prefix /opt/tools/npm-global、pip --target /opt/tools/py。',
  '- skill 全文绝不整段塞进配置描述;description 保持一句话触发条件。',
  '- 完成后用 list_tool_config 核对,并告知用户"对目标智能体的新会话生效"。',
].join('\n');
