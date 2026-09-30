/**
 * pi session store.
 *
 * One pi Agent instance per session. Every agent event is journaled with a
 * monotonic sequence number and fanned out to that session's SSE subscribers.
 * Sessions are in-memory in this phase; pi state survives in the Agent
 * object for the process lifetime.
 */

import crypto from 'node:crypto';

import { Agent, formatSkillsForSystemPrompt } from '@earendil-works/pi-agent-core';

import { CONFIG } from './config.mjs';
import { typeLabelOf, CONFIG_AGENT_KEYS } from './agents.mjs';
import { effectiveCommon, effectiveBruteParams } from './agent-settings.mjs';
import { ORCHESTRATOR_PROMPT, STAGE_PROMPT, RECON_PROMPT, NDAY_PROMPT, BRUTE_PROMPT, API_PROMPT, VULNHUNT_PROMPT, C2_PROMPT, PERSIST_PROMPT, POSTEX_PROMPT, PHISH_PROMPT, TOOLS_GUIDE, SKILL_CONFIG_PROMPT, MCP_CONFIG_PROMPT, CLI_CONFIG_PROMPT, clipMarked, normalizeMessage, noteRateLimit, truncateText } from './pi.mjs';
import { mountForSession, skillsCached } from './sandbox/mount.mjs';
import { buildToolingTools } from './sandbox/tooling.mjs';
import { buildChildTools, buildDirectTools, buildIntelTools, buildOrchestratorTools, buildShellTools } from './tools.mjs';
import { Summarizer } from './summarizer.mjs';
// CS1-A4: 单源常量(此前与 workflows.mjs 双胞胎漂移, workflows 侧曾把 status 说成必填)。
import { REPORT_NUDGE_TEXT } from './nudge-text.mjs';

/** Disk-full resilience: a failing WAL append must degrade to a log
 *  line, never crash the agent loop at the exact moment durability
 *  matters most. */
function safeWalAppend(wal, entry) {
  try { wal?.append?.(entry); } catch (e) {
    console.error('[wal] append failed (degraded):', e?.message ?? e);
  }
}

const TOOLS_PROMPTS = {
  'skill-config': SKILL_CONFIG_PROMPT,
  'mcp-config': MCP_CONFIG_PROMPT,
  'cli-config': CLI_CONFIG_PROMPT,
};
/** Business agents with a SPECIALTY prompt: prepended BEFORE STAGE_PROMPT
 *  (business discipline + TOOLS_GUIDE still apply — unlike config agents,
 *  which fully replace the prompt and skip the guide). */
const BUSINESS_PROMPTS = {
  recon: RECON_PROMPT,
  nday: NDAY_PROMPT,
  weakcred: BRUTE_PROMPT,
  api: API_PROMPT,
  exploit: VULNHUNT_PROMPT,
  c2: C2_PROMPT,
  persistence: PERSIST_PROMPT,
  phish: PHISH_PROMPT,
  postex: POSTEX_PROMPT,
};

const ORCHESTRATOR_KEY = 'autopwn';

/**
 * Origin heuristic for system-injected user-role turns. Our own DM
 * emissions carry a "[DM from x]" prefix → 'agent'; every other
 * injection (engagement-done, report nudges, spawn tasks) → 'system'.
 * The real human user NEVER passes through here.
 */
export const injectionOriginOf = (text) =>
  String(text).startsWith('[DM from ') ? 'agent' : 'system';

let seq = 0;

export class SessionStore {
  /**
   * @param {{model: object, streamFn: Function,
   *          caps?: object, summarizer?: object}} deps
   * caps: { dispatch, signalEngagement, emitBus, followUp } — injected by
   * the composition root so this store never imports Temporal or the bus.
   * summarizer: title/brief generator (same model, policy-bounded).
   */
  constructor({ model, streamFn, caps = {}, summarizer = null, wal = null }) {
    this.model = model;
    this.streamFn = streamFn;
    this.caps = caps;
    this.summarizer = summarizer;
    this.wal = wal;
    this.sessions = new Map();
  }

  /**
   * @param {string} agentKey
   * @param {{engagementId?: string, orchestratorSessionId?: string,
   *          workSessionId?: string, parentSessionId?: string,
   *          name?: string, description?: string}} [opts]
   *   engagementId/orchestratorSessionId mark the session as an AutoPwn
   *   child — those carry report_vulnerability / publish_intel /
   *   request_vulnerability_revision / spawn_agent (CS3-N2: 漏洞撰写
   *   收权后子会话不持 publish_vulnerability, 见 tools.mjs 矩阵)。
   */
  create(agentKey, opts = {}) {
    const id = `sess-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const record = {
      id,
      agentKey,
      createdAt: new Date().toISOString(),
      engagementId: opts.engagementId ?? null,
      orchestratorSessionId: opts.orchestratorSessionId ?? null,
      workSessionId: opts.workSessionId ?? null,
      parentSessionId: opts.parentSessionId ?? null,
      activeEngagement: null,
      title: null,
      spawnName: typeof opts.name === 'string' && opts.name.trim()
        ? opts.name.trim().slice(0, 30) : null,
      spawnDescription: typeof opts.description === 'string'
        && opts.description.trim() ? opts.description.trim().slice(0, 80) : null,
      lastActivityTs: Date.now(),
      summarizeBusy: false,
      events: [],
      clients: new Set(),
      busy: false,
      spawnReports: 0,
      taskReportCount: 0,
      reportNudges: 0,
      lastReport: null,
      agent: null,
    };
    record.agent = this._buildAgent(record);
    this.sessions.set(id, record);
    // Durable before visible: the WAL entry carries the full shell, so a
    // restart replays this session exactly (minus the live SSE clients).
    safeWalAppend(this.wal, { t: 'sess', d: this._shellOf(record) });
    this._journal(record, 'session_created', {
      agentKey,
      engagementId: record.engagementId,
      parentSessionId: record.parentSessionId,
    });
    return record;
  }

  /** Fields needed to rebuild a record shell (everything except runtime
   *  state: agent, events journal, SSE clients, busy/summarizeBusy). */
  _shellOf(record) {
    return {
      id: record.id,
      agentKey: record.agentKey,
      createdAt: record.createdAt,
      engagementId: record.engagementId,
      orchestratorSessionId: record.orchestratorSessionId,
      workSessionId: record.workSessionId,
      parentSessionId: record.parentSessionId,
      activeEngagement: record.activeEngagement,
      title: record.title,
      rawTitle: record.rawTitle ?? record.title,  // R32D32-R2: detail 对齐 list/tree 投影
      spawnName: record.spawnName,
      spawnDescription: record.spawnDescription,
      spawnReports: record.spawnReports,
      taskReportCount: record.taskReportCount,
      reportNudges: record.reportNudges,
      lastReport: record.lastReport,
    };
  }

  /**
   * Boot warm-up race fix: rehydrate builds agents synchronously with an
   * EMPTY mount cache; rebuildMounts fills it later (async boot block).
   * Rehydrated sessions therefore kept tool surfaces without MCP tools —
   * forever, on every restart (live regression: round-3 interview agent
   * saw zero mcp_* tools after a restart, fresh sessions were fine).
   * Called once after rebuildMounts; never touches busy sessions.
   */
  rebuildSessionAgents() {
    let n = 0;
    for (const record of this.sessions.values()) {
      if (!record.agent || record.busy) continue;
      try {
        record.agent = this._buildAgent(record, record.agent.state.messages);
        n += 1;
      } catch { /* keep old agent — must never be fatal */ }
    }
    return n;
  }

  /** Construct the pi Agent for a record (fresh or rehydrated transcript). */
  _buildAgent(record, messages = []) {
    const isOrchestrator = record.agentKey === ORCHESTRATOR_KEY;
    const hasParent = Boolean(record.engagementId || record.parentSessionId);
    // Tool matrix: orchestrators stack child OUTPUT tools (report/
    // publish/revise-request — the orchestrator is the one agent that
    // sees the whole project, it must be able to file leads; live
    // regression proved the static roster lied to it) minus the
    // duplicate spawn_agent; every agent queries intel.
    // E1(铁律:有且只有): 配置agent第一分支——只持自己的配置工具
    // +官方 bash/read/write/edit;业务工具集(report_vulnerability/
    // publish_intel/...)不属于它们。此前落入 buildDirectTools 默认尾
    // =全套业务工具(CONFIG_AGENT_KEYS 死代码从未接线)。
    const isConfigAgent = CONFIG_AGENT_KEYS.includes(record.agentKey);  // CS2-#5 单源
    // CS3-N4(共享工具铁律补面): R31 只给 direct 会话补了各持独立的
    // search_web/fetch_url——engagement 子会话与编排器同样需要(RECON_
    // PROMPT 指挥被派发的 recon 用 fetch_url 核验, 此前子会话无此工具)。
    const base = isOrchestrator
      ? [
        ...buildOrchestratorTools(record, this.caps),
        ...buildChildTools(record, this.caps).filter(t => t.name !== 'spawn_agent'),
        ...buildIntelTools(record, this.caps),
        ...buildToolingTools(record, this.caps),
      ]
      : isConfigAgent
        ? buildToolingTools(record, this.caps)
        : hasParent
          ? [...buildChildTools(record, this.caps), ...buildIntelTools(record, this.caps),
            ...buildToolingTools(record, this.caps)]
          : [...buildDirectTools(record, this.caps),
            ...buildIntelTools(record, this.caps)];
    // Sandbox layer: official bash/read/write/edit (ExecutionEnv-bound,
    // project cwd) + per-agent MCP tools + per-agent skill index.
    const mount = mountForSession(record.agentKey, record.workSessionId);
    // Shell channel: c2 (deliver/handoff), persistence & postex (operate),
    // autopwn (relay/verify) — one instance per session (independence axiom).
    if (['c2', 'persistence', 'postex', 'autopwn'].includes(record.agentKey)) {
      base.push(...buildShellTools(record, this.caps));
    }
    const tools = [...base, ...mount.tools];
    const skills = skillsCached(record.agentKey);
    const skillIndexBlock = skills.length
      ? formatSkillsForSystemPrompt(skills) : '';
    const agent = new Agent({
      initialState: {
        // Dynamic tool roster: generated from the ACTUAL registered set —
        // the prompt can never again claim a tool this session lacks.
        // Prompt layering: config agents fully replace (no business guide);
        // business specialty agents (recon) PREPEND their playbook — the
        // stage discipline and TOOLS_GUIDE still apply underneath.
        systemPrompt: `${TOOLS_PROMPTS[record.agentKey]
            ?? (BUSINESS_PROMPTS[record.agentKey]
              ? `${BUSINESS_PROMPTS[record.agentKey]}\n\n${STAGE_PROMPT}`
              : (isOrchestrator ? ORCHESTRATOR_PROMPT : STAGE_PROMPT))}\n\n` +
          // Config agents hold no business platform tools — the business
          // TOOLS_GUIDE would be pure noise (and boundary pollution).
          `${TOOLS_PROMPTS[record.agentKey] ? ''
            : TOOLS_GUIDE + '\n'}` +
          `${tools.map(t => `- ${t.name}`).join('\n')}` +
          (skillIndexBlock ? `\n\n${skillIndexBlock}` : '') +
          (record.agentKey === 'weakcred' ? `\n\n# 当前爆破参数(用户配置,实时生效)\n${JSON.stringify(effectiveBruteParams())}` : ''),
        model: this.model,
        tools,
        // Thinking effort is user-configurable (settings bar); pi levels
        // pass through the model's thinkingLevelMap (GLM) or raw to vendor.
        thinkingLevel: effectiveCommon().thinkingLevel,
        messages,
      },
      streamFn: this.streamFn,
      sessionId: record.id,
    });
    agent.subscribe(event => this._onAgentEvent(record, event));
    return agent;
  }

  /**
   * Boot recovery: rebuild records from WAL replay. Messages restore the
   * full LLM context (Agent initialState.messages), so conversations and
   * dispatch trees resume exactly where they stopped.
   * @param {Array<{shell: object, messages: object[], meta?: object}>} items
   */
  rehydrate(items) {
    for (const { shell, messages = [], meta = {} } of items) {
      const record = {
        ...shell,
        ...meta,
        brief: meta.brief ?? null,
        briefUpTo: meta.briefUpTo ?? 0,
        lastActivityTs: meta.lastActivityTs ?? Date.now(),
        summarizeBusy: false,
        events: [],
        clients: new Set(),
        busy: false,
        agent: null,
      };
      try {
        record.agent = this._buildAgent(record, messages);
      } catch (e) {
        // R1-F4: 毒多半在重放消息里——先以空消息重建降级活 agent
        // (保会话可用); 再失败才 inert。此前直接 inert, 但下游读取
        // 未判空, 一条毒记录让 GET /api/sessions 全体 500。
        try {
          record.agent = this._buildAgent(record, []);
          console.error(`[rehydrate] session ${record.id} 降级重建(丢历史消息):`, e?.message ?? e);
        } catch (e2) {
          // one poisoned record must never abort the whole boot — skip
          // and keep going (the session stays inert rather than fatal;
          // 读取路径已全部判空, 见 R1-F4)
          console.error(`[rehydrate] skip session ${record.id}:`, e2?.message ?? e2);
          record.agent = null;
        }
      }
      this.sessions.set(record.id, record);
    }
  }

  /** Current state for WAL compaction (boot/shutdown rewrite). */
  snapshotForDisk() {
    return [...this.sessions.values()].map(s => ({
      t: 'sess',
      d: this._shellOf(s),
      m: s.agent?.state.messages ?? [],
      meta: {
        brief: s.brief,
        briefUpTo: s.briefUpTo,
        lastActivityTs: s.lastActivityTs,
        title: s.title,
        rawTitle: s.rawTitle,  // R32D31-E1: compaction 保未截断标题
      },
    }));
  }

  /** Mutable meta tracked across messages (piggybacked on WAL entries). */
  _metaOf(record) {
    return {
      title: record.title,
      rawTitle: record.rawTitle,  // R32D31-E1: 未截断标题随 WAL 持久化
      brief: record.brief,
      briefUpTo: record.briefUpTo,
      spawnName: record.spawnName,
      spawnDescription: record.spawnDescription,
      spawnReports: record.spawnReports,
      taskReportCount: record.taskReportCount,
      reportNudges: record.reportNudges,
      lastReport: record.lastReport,
      activeEngagement: record.activeEngagement,
      lastActivityTs: record.lastActivityTs,
    };
  }

  get(id) {
    return this.sessions.get(id) ?? null;
  }

  /** R1-F4: inert 会话(agent=null, WAL 毒记录)入口守卫——返回 503
   * 而非卡 busy=true + 未处理 rejection(可能进程退出)。 */
  _requireLiveAgent(record) {
    if (!record.agent) {
      throw Object.assign(
        new Error('会话惰性(WAL 毒记录)——见 runtime 日志'),
        { statusCode: 503 });
    }
  }

  /**
   * Display title projection: the LLM one-shot title when present, else a
   * first-user-message excerpt. Projection only — record.title stays null
   * until the summarizer sets it, so the `!record.title` generation gate
   * (and the `<title/>` decline path) is unaffected.
   */
  _displayTitle(record) {
    if (record.title) return record.title;
    const first = record.agent?.state.messages.find(m => m.role === 'user') ?? null;
    const text = first ? (normalizeMessage(first).text || '').trim() : '';
    if (!text) return null;
    const line = (text.split('\n').find(l => l.trim()) ?? '').trim();
    if (!line) return null;
    return line.length > 40 ? `${line.slice(0, 40)}…` : line;
  }

  list() {
    return [...this.sessions.values()].map(s => ({
      id: s.id,
      agentKey: s.agentKey,
      title: this._displayTitle(s),
      // R32D31-E1: 搜索面用未截断原始标题(截断只管显示); 无 LLM 标题
      // 的会话回落截断显示值(首消息摘录本身 ≤40+…)。
      rawTitle: s.rawTitle ?? this._displayTitle(s),
      createdAt: s.createdAt,
      busy: s.busy,
      messages: s.agent?.state.messages.length ?? 0,
      engagementId: s.engagementId,
      orchestratorSessionId: s.orchestratorSessionId,
      workSessionId: s.workSessionId,
      parentSessionId: s.parentSessionId,
      spawnName: s.spawnName,
      spawnDescription: s.spawnDescription,
      brief: s.brief,
    }));
  }

  summary(record) {
    return {
      id: record.id,
      agentKey: record.agentKey,
      title: this._displayTitle(record),
      rawTitle: record.rawTitle ?? this._displayTitle(record),  // R32D32-R2: 对齐 list/tree
      createdAt: record.createdAt,
      busy: record.busy,
      engagementId: record.engagementId,
      spawnName: record.spawnName,
      spawnDescription: record.spawnDescription,
      messages: (record.agent?.state.messages ?? []).map(m => normalizeMessage(m)),
      brief: record.brief,
      // SSE cursor: clients subscribe with ?since=lastSeq to avoid
      // replaying the history they just fetched.
      lastSeq: this.lastSeq(record),
    };
  }

  /**
   * Fire-and-forget prompt; results stream via SSE. Rejects while busy.
   * `busy` flips synchronously BEFORE agent.prompt() resolves its first
   * microtask — waitIdle callers must never observe idle in the dispatch
   * window, or they'd harvest an empty reply (the "(无输出)" bug).
   */
  prompt(record, text, source) {
    this._requireLiveAgent(record);
    if (record.busy) {
      throw Object.assign(new Error('agent 忙(并发锁定)——请用 steer'), { statusCode: 409 });
    }
    record.busy = true;
    // Context compaction (user-configurable window): when the running
    // context exceeds window−reserve, summarize the head and keep the
    // recent tail — BEFORE queuing the new turn, while the agent is idle.
    this._maybeCompact(record).catch(() => { /* compaction is best-effort */ })
      .finally(() => {
        // `source` tags WHO injected this user-role turn ('system'|'agent');
        // absent = the real human user. Survives to the console via
        // normalizeMessage so injections never render as "you".
        const msg = source
          ? { role: 'user', content: text, timestamp: Date.now(), source }
          : text;
        record.agent.prompt(msg).catch(err => {
          // R1-F2: 'already processing' 恰恰意味着另一运行在途(竞态败
          // 者)——此时 agent 正在流式, 清 busy 会让 waitIdle 收割旧回
          // 复、并发 /messages 绕过 409。只在真实非流式时清。
          if (!record.agent.state.isStreaming) {
            record.busy = false;  // run never started — don't strand waitIdle
            // R15-F4: 事件驱动等待者(reportWriter 等 awaitCompletion)
            // 此前被困 300s——agent_end 永不来, busy 快路径已过。
            for (const fn of record.completionWaiters ?? [])
              { try { fn(); } catch { /* best-effort: 单 waiter 异常不阻断其余 */ } }
            record.completionWaiters = [];
          }
          this._journal(record, 'error', { message: String(err) });
        });
      });
  }

  /** Lightweight context compaction (settings-driven):
   *  head messages → one summary message, keep recent tail. Runs only when
   *  the configured threshold trips; journal records the cut. */
  async _maybeCompact(record) {
    const eff = effectiveCommon();
    if (!eff.compaction.enabled) return;
    const msgs = record.agent.state.messages;
    if (msgs.length < 8) return;
    // last assistant usage = live context size (pi calculateContextTokens)
    const lastA = [...msgs].reverse().find(m => m.role === 'assistant' && m.usage);
    const ctx = lastA?.usage?.totalTokens
      ?? lastA ? (lastA.usage.input + lastA.usage.output + (lastA.usage.cacheRead || 0) + (lastA.usage.cacheWrite || 0)) : 0;
    const threshold = eff.contextWindow - eff.compaction.reserveTokens;
    if (!ctx || ctx <= threshold) return;
    // split: keep the recent tail (approx by tokens: ~1 token ≈ 4 chars)
    const keepChars = eff.compaction.keepRecentTokens * 4;
    let tail = [];
    let used = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const size = JSON.stringify(m.content ?? m.text ?? '').length + 200;
      if (used + size > keepChars && tail.length >= 4) break;
      tail.unshift(m); used += size;
    }
    // R21-F4: 前导 toolResult 越过配对边界归入 head——悬挂的无主
    // role:'tool'(其配对 assistant 在 head)会让后续每轮请求 400
    // 且随压缩固化。
    let cut = msgs.length - tail.length;
    while (cut < msgs.length && msgs[cut].role === 'toolResult') cut += 1;
    tail = msgs.slice(cut);
    const head = msgs.slice(0, cut);
    if (!head.length) return;
    // one summarizer call through the SAME streamFn/model
    const transcript = head.map(m => `${m.role}: ${typeof m.content === 'string'
      ? m.content : JSON.stringify(m.content ?? '')}`).join('\n').slice(0, 240_000);
    const r = await this.streamFn(this.model, { system: 'You are a session summarizer. Summarize the conversation so far: participants, decisions, tool findings, pending work. Be dense and factual; the summary replaces the history.', messages: [{ role: 'user', content: transcript }] }, { maxTokens: 4096 });
    if (r.stopReason !== 'stop' && r.stopReason !== 'length') return;
    const summaryText = (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('');
    if (!summaryText) return;
    const compactMsg = {
      role: 'user', timestamp: Date.now(), source: 'system',
      content: `【上下文压缩】此前 ${head.length} 条消息已压缩为摘要,近期 ${tail.length} 条保留原文:\n\n${summaryText}`,
    };
    record.agent.state.messages = [compactMsg, ...tail];
    record.briefUpTo = 0;  // R21-F3: 消息数骤降, 滚动简述游标归零重算
    this._journal(record, 'compaction', {
      summarized: head.length, kept: tail.length,
      tokensBefore: ctx, tokensAfter: '~' + Math.ceil(summaryText.length / 4),
    });
  }

  /** Queue a steering message for delivery after the current turn. */
  steer(record, text, source) {
    this._requireLiveAgent(record);
    // R1-F3: pi 的 steer 队列只在运行回合结束注入——空闲 agent 上的
    // steer 会滞留队列(若再无 prompt 则永不送达, 202 却静默丢弃; 若随
    // 后有 prompt 则注入顺序倒置: 后发的用户消息先入上下文, 实测确
    // 认)。空闲时直达 prompt(复用 busy 翻转/409/正确次序); 忙时保留
    // 队列路径(正是指令语义: 运行中转向)。
    if (!record.busy && !record.agent.state.isStreaming) {
      return this.prompt(record, text, source);
    }
    record.agent.steer(source
      ? { role: 'user', content: text, timestamp: Date.now(), source }
      : { role: 'user', content: text, timestamp: Date.now() });
    this._journal(record, 'steer_queued', { text: truncateText(text, 200) });
  }

  /**
   * Inject a follow-up message for the orchestrator loop. pi's followUp
   * queue only drains at run end — on an idle agent it never fires, so we
   * prompt directly instead (same transcript shape: a user-role message).
   *
   * `source` defaults to the injection-origin heuristic: our own DM
   * emissions carry a "[DM from x]" prefix → 'agent'; everything else
   * (engagement-done, report nudges) → 'system'. Never the human user.
   *
   * Race safety: `busy` is event-driven and can lag; on a lost race pi's
   * prompt() rejects with "already processing" — fall back to the queue
   * instead of surfacing an error.
   */
  followUp(record, text, source = injectionOriginOf(text)) {
    this._requireLiveAgent(record);
    const agent = record.agent;
    const msg = { role: 'user', content: text, timestamp: Date.now(), source };
    const queue = () => {
      agent.followUp(msg);
      this._journal(record, 'followup_queued', { text: truncateText(text, 200) });
    };
    if (agent.state.isStreaming) {
      queue();
      return;
    }
    record.busy = true;  // same synchronous-flip rule as prompt()
    this._journal(record, 'followup_injected', { text: truncateText(text, 200) });
    Promise.resolve(record.agent.prompt(msg)).catch(() => {
      // R1-F2: 同 prompt()——输给竞态时不清 busy(见上)。
      if (!record.agent.state.isStreaming) {
        record.busy = false;
        for (const fn of record.completionWaiters ?? [])
        { try { fn(); } catch { /* best-effort(同上) */ } }  // R15-F4
        record.completionWaiters = [];
      }
      queue();
    });
  }

  async waitIdle(record) {
    const deadline = Date.now() + CONFIG.maxIdleWaitMs;
    while (record.busy && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    // R1-F4: inert 会话直接判空闲(无消息可收割)
    if (!record.agent) return { sessionId: record.id, idle: true, reply: '' };
    const last = [...record.agent.state.messages].reverse()
      .find(m => m.role === 'assistant');
    return {
      sessionId: record.id,
      idle: !record.busy,
      reply: last ? normalizeMessage(last).text : '',
    };
  }

  /** Replay journalled events past `since`, then attach the SSE client. */
  attach(record, stream, since = 0) {
    for (const event of record.events.filter(e => e.seq > since)) {
      stream.write(`event: session\ndata: ${JSON.stringify(event)}\n\n`);
    }
    record.clients.add(stream);
    stream.on('close', () => record.clients.delete(stream));
  }

  /** Latest journal sequence — clients resume their SSE cursor here. */
  lastSeq(record) {
    return record.events.at(-1)?.seq ?? 0;
  }

  _journal(record, type, data = {}) {
    const event = {
      seq: ++seq,
      ts: new Date().toISOString(),
      sessionId: record.id,
      agentKey: record.agentKey,
      type,
      data,
    };
    record.events.push(event);
    this._broadcast(record, event);
    return event;
  }

  /**
   * Ephemeral stream frame: pushed to live SSE clients but NOT journalled —
   * late subscribers get the full text via the final `message` event.
   */
  _stream(record, type, data) {
    this._broadcast(record, {
      seq: ++seq, ts: new Date().toISOString(),
      sessionId: record.id, agentKey: record.agentKey, type, data,
    });
  }

  _broadcast(record, event) {
    const frame = `event: session\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of record.clients) {
      // R26-F4: 半开/零窗连接(close 永不触发)使 Node 用户态缓冲无界
      // 积压——write()===false 连续超限即销毁该连接(close 清理路径
      // 接手; attach(since)+lastSeq 游标本为断线重连设计)。
      if (client.write(frame)) {
        client.__congested = 0;
      } else if ((client.__congested = (client.__congested || 0) + 1) >= 500) {
        client.destroy();
      }
    }
  }

  /**
   * Tree topology helpers: edges are parentSessionId ?? orchestratorSessionId
   * (workflow children attach to the root orchestrator session; runtime
   * spawned nodes attach to their spawner).
   */
  parentNodeId(record) {
    return record.parentSessionId ?? record.orchestratorSessionId ?? null;
  }

  depthOf(sessionId, seen = new Set()) {
    if (!sessionId || seen.has(sessionId)) return 0;
    seen.add(sessionId);
    const record = this.sessions.get(sessionId);
    if (!record) return 0;
    const parent = this.parentNodeId(record);
    return parent ? 1 + this.depthOf(parent, seen) : 0;
  }

  rootIdOf(sessionId, seen = new Set()) {
    if (!sessionId || seen.has(sessionId)) return sessionId;
    seen.add(sessionId);
    const record = this.sessions.get(sessionId);
    if (!record) return sessionId;
    const parent = this.parentNodeId(record);
    return parent ? this.rootIdOf(parent, seen) : sessionId;
  }

  /**
   * Tree size. activeOnly: completed sessions (filed a task report AND
   * no run in flight) don't count against spawn quota — the P2 fix:
   * total-count quota permanently locked dispatch once the tree grew
   * past the cap with finished agents. Re-activation (prompt/followUp)
   * flips `busy` synchronously, putting the session back in the count.
   */
  countTree(rootId, { activeOnly = false } = {}) {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (this.rootIdOf(s.id) !== rootId) continue;
      if (activeOnly && s.taskReportCount > 0 && !s.busy) continue;
      n += 1;
    }
    return n;
  }

  /** Member agentKeys of an engagement (derived from live sessions —
   *  engagement children carry engagementId; restart-safe via WAL). */
  engagementMembersOf(engagementId) {
    if (!engagementId) return [];
    const members = new Set();
    for (const s of this.sessions.values()) {
      if (s.engagementId === engagementId) members.add(s.agentKey);
    }
    return [...members];
  }

  /** Workflow-side synthesized-report marker: bump counter + persist
   *  meta so the activeOnly quota releases the slot across restarts. */
  markReportSynthesized(record, meta = {}) {
    record.taskReportCount += 1;
    record.lastReport = {
      title: String(meta.title ?? '[系统代拟] 任务报告'),
      status: String(meta.status ?? 'no-result'),
    };
    safeWalAppend(this.wal, { t: 'meta', d: { sid: record.id, meta: this._metaOf(record) } });
  }

  /** Resolve when the session's current run ends (agent_end). Purely
   *  event-driven — used by the synchronous report_vulnerability tool
   *  to wait for its writer session. Resolves immediately if idle. */
  awaitCompletion(record, timeoutMs) {
    if (!record.busy) return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      (record.completionWaiters ??= []).push(done);
      // bounded wait: a wedged agent (hung MCP call, lost stream) must
      // release its synchronous waiter — wake_agent/report_vulnerability
      // callers used to stay busy FOREVER on this path
      if (timeoutMs) setTimeout(done, timeoutMs).unref?.();
    });
  }

  /**
   * Provenance snapshot for intel events (task reports / vulns / notes):
   * author name, stage type, parent agent, tree path. Computed at emit
   * time and frozen into the event — later tree changes never rewrite
   * published provenance.
   */
  authorOf(record) {
    const label = rec => rec.spawnName
      ?? (rec.agentKey === ORCHESTRATOR_KEY ? '主控' : rec.agentKey);
    const chain = [];
    const seen = new Set();
    for (let cur = record; cur && !seen.has(cur.id);) {
      seen.add(cur.id);
      chain.unshift(cur);
      const pid = this.parentNodeId(cur);
      cur = pid ? this.sessions.get(pid) : null;
    }
    const parentRec = chain.length > 1 ? chain[chain.length - 2] : null;
    return {
      key: record.agentKey,
      name: label(record),
      typeLabel: typeLabelOf(record.agentKey),
      parent: parentRec ? { key: parentRec.agentKey, name: label(parentRec) } : null,
      treePath: chain.map(label).join(' › '),
      depth: chain.length - 1,
      sessionId: record.id,
      workSessionId: record.workSessionId ?? null,
      engagementId: record.engagementId ?? null,
    };
  }

  /**
   * A runtime-spawned node reports its final reply back to its spawner as
   * a [DM] (same channel the report tool uses), so the spawner can chain.
   */
  _reportSpawnCompletion(record) {
    if (!record.parentSessionId || !this.caps.followUp) return;
    // Task-report gate (policy, SYSTEM-side only — the spawner never
    // spends attention on compliance): a dispatched task must have AT
    // LEAST ONE report before it goes quiet. Zero → nudge (≤
    // CONFIG.reportNudgeMax) → system-synthesized fallback, never a hole.
    // A BROKEN agent (every assistant message empty / errored — the B-2
    // anomaly: LLM transport failure, nudging is wasted API calls) skips
    // nudges and synthesizes a failed report immediately.
    const reported = record.taskReportCount > 0;
    if (!reported) {
      const functional = record.agent.state.messages.some(m => {
        if (m.role !== 'assistant') return false;
        const norm = normalizeMessage(m);
        return (norm.text || '').trim() || norm.toolCalls?.length;
      });
      if (functional && record.reportNudges < CONFIG.reportNudgeMax) {
        record.reportNudges += 1;
        this._journal(record, 'report_nudge', { nudge: record.reportNudges });
        // Defer past this agent_end dispatch: prompting the child from
        // inside its own event handler gets rejected by pi ("already
        // processing") and the queued fallback never drains on an idle
        // agent — the task would stall with no report and no DM.
        setTimeout(() => this.caps.followUp(record.id, REPORT_NUDGE_TEXT), 0);
        return;  // next agent_end re-enters the gate
      }
      this._synthesizeReport(record, functional ? undefined : 'broken');
    }
    record.reportNudges = 0;

    // GLM sometimes ends a turn right after a tool receipt with an EMPTY
    // final message — walk back to the newest assistant message with text.
    const replies = [...record.agent.state.messages]
      .reverse().filter(m => m.role === 'assistant');
    const withText = replies.find(m =>
      (normalizeMessage(m).text || '').trim());
    const reply = withText
      ? (normalizeMessage(withText).text || '').trim() : '(无输出)';
    // Label honesty: run 1 of a spawned task is its completion; later runs
    // only happen after steer/followUp injections — progress, not another
    // "完成" (interim DMs mislabeled as completion fueled project-3's
    // "回执为空/正文丢失" narratives).
    record.spawnReports += 1;
    const label = record.spawnReports === 1 ? '派生任务完成' : '派生任务进展更新';
    const errorNote = (() => {
      const errs = record.agent.state.messages
        .filter(m => m.role === 'assistant' && m.stopReason === 'error')
        .map(m => m.errorMessage || '');
      return errs.length ? `\n⚠️ 该智能体运行出错:${errs[0].slice(0, 160) || '未知错误(见会话)'}` : '';
    })();
    // Fix-I (P12): when vulnerabilities were published this run, the spawner
    // already got their full text via auto-DM — reference them instead
    // of letting the reply repeat the content (dual-channel redundancy
    // burned 1-2 turns per spawn in project-3).
    const vulnNote = record.publishedVulnTitles?.length
      ? `\n已发布 ${record.publishedVulnTitles.length} 条漏洞:` +
        `${record.publishedVulnTitles.map(t => `《${clipMarked(t, 40)}》`).join('')}` +
        `,全文经 query_intel 检索。\n`
      : '';
    this.caps.followUp(
      record.parentSessionId,
      `[DM from ${record.agentKey}] ${label}:\n${vulnNote}${clipMarked(
        reply,
        CONFIG.dmDigestChars,
        `任务报告已入库,用 query_intel 读取;原始回复见会话 ${record.id}`,
      )}${errorNote}`,
    );
    this.caps.emitBus?.({
      channel: 'dm', from: record.agentKey, to: 'spawner',
      type: 'spawn-result',
      summary: `${label}:${reply.slice(0, 120)}`,
      workSessionId: record.workSessionId ?? null,
    });
  }

  /**
   * Fallback when an agent never reports: synthesize so the invariant
   * holds. `cause` marks why — nudged-out (agent was functional but
   * refused) vs broken (LLM transport failure, nothing to salvage).
   * Clearly marked 代拟; failures carry status 'failed'.
   */
  _synthesizeReport(record, cause) {
    const last = [...record.agent.state.messages].reverse()
      .find(m => m.role === 'assistant' && (normalizeMessage(m).text || '').trim());
    const reply = last ? normalizeMessage(last).text : '(无输出)';
    const broken = cause === 'broken';
    const error = record.agent.state.messages
      .find(m => m.role === 'assistant' && m.stopReason === 'error' && m.errorMessage);
    record.taskReportCount += 1;
    record.lastReport = {
      title: `[系统代拟] ${record.spawnName ?? record.agentKey} 任务报告`,
      status: broken ? 'failed' : 'no-result',
    };
    this.caps.emitBus?.({
      channel: 'share', from: record.agentKey, type: 'task-report',
      author: this.authorOf(record),
      status: broken ? 'failed' : 'no-result',
      title: record.lastReport.title,
      summary: broken
        ? '智能体运行异常(全部回复为空/出错),系统代拟失败报告'
        : 'agent 未提交,系统依据最终回复代拟',
      detail: broken
        ? `**状态**:failed(系统代拟)\n\n## 说明\n该智能体的所有回复均为空或出错,疑似 LLM 调用故障,任务未执行。` +
          `\n\n## 错误信息\n\`\`\`\n${(error?.errorMessage || '未记录(见会话日志)').slice(0, 300)}\n\`\`\``
        : `**状态**:no-result(系统代拟)\n\n## 说明\n该智能体经 ${CONFIG.reportNudgeMax} 次催办后仍未调用 submit_task_report。\n\n## 最终回复原文\n${reply}`,
      workSessionId: record.workSessionId ?? null,
      engagement: record.engagementId ? `autopwn-${record.engagementId}` : null,
    });
  }

  /**
   * Policy-bounded summary scheduler — fire-and-forget at agent_end.
   * Title: once, after the first exchange. Brief: eager at delta>=8,
   * or a delayed idle check (10min) at delta>=4. One job per session.
   */
  _maybeSummarize(record) {
    if (!this.summarizer) return;
    // R26-F2: 在飞时不再丢弃调度——记 pending, 作业落定后重评(空闲会话
    // 的尾部消息此前永久漏出简述覆盖窗口)。
    if (record.summarizeBusy) { record.summarizePending = true; return; }
    if (!record.title) {
      // R26-F1: 标题作业落定后补评 brief 分支——此前标题分支独占
      // return, 产不出标题的会话(问候开场 isLowSignal 短路等)其滚动
      // 简述被永久饿死; decline 重试语义(displayTitle 投影注释自证)
      // 保留——补评只走 brief 判据, 不重入标题分支。
      this._runSummarizeJob(record,
        () => this.summarizer.generateTitle(record),
        () => this._maybeScheduleBrief(record));
      return;
    }
    this._maybeScheduleBrief(record);
  }

  _maybeScheduleBrief(record) {
    const cfg = {
      minDelta: CONFIG.summaryMinDelta,
      eagerDelta: CONFIG.summaryEagerDelta,
      idleMs: CONFIG.summaryIdleMs,
    };
    if (Summarizer.shouldRefreshBrief(record, cfg)) {
      this._runSummarizeJob(record, () => this.summarizer.refreshBrief(record));
    } else if (record.agent.state.messages.length - record.briefUpTo
               >= cfg.minDelta) {
      const delay = Math.max(0,
        cfg.idleMs - (Date.now() - record.lastActivityTs));
      setTimeout(() => {
        // still idle since schedule time and still enough new material
        const stillDelta = record.agent.state.messages.length - record.briefUpTo;
        if (record.busy || stillDelta < cfg.minDelta) {
          return;
        }
        // R26-F2: 到点恰逢摘要作业在飞——改记 pending 待落定重评,
        // 不再裸退吞掉本批消息的调度。
        if (record.summarizeBusy) { record.summarizePending = true; return; }
        this._runSummarizeJob(record, () => this.summarizer.refreshBrief(record));
      }, delay);
    }
  }

  _runSummarizeJob(record, job, after) {
    // R26-F3: 捕获作业前摘要面——变异即追加 meta 落盘(镜像
    // markReportSynthesized 纪律); 此前摘要成果只在下一次
    // message_end/agent_end piggyback 才落盘, 空闲窗口内硬崩溃
    // 丢失已花费 LLM 成本的标题与简述。
    const before = { title: record.title, brief: record.brief,
                     briefUpTo: record.briefUpTo };
    record.summarizeBusy = true;
    (async () => {
      try {
        await job();
      } catch (err) {
        console.error(`[summarizer] ${record.id}:`, String(err));
      } finally {
        record.summarizeBusy = false;
        const mutated = record.title !== before.title
          || record.brief !== before.brief
          || record.briefUpTo !== before.briefUpTo;
        if (mutated) {
          safeWalAppend(this.wal, {
            t: 'meta', d: { sid: record.id, meta: this._metaOf(record) },
          });
        }
        if (after) after();
        if (record.summarizePending) {
          record.summarizePending = false;
          this._maybeSummarize(record);
        }
      }
    })();
  }

  _onAgentEvent(record, event) {
    switch (event.type) {
      case 'message_update': {
        const update = event.assistantMessageEvent;
        if (update?.type === 'text_delta' && update.delta) {
          this._stream(record, 'delta', { delta: update.delta });
        } else if (update?.type === 'thinking_delta' && update.delta) {
          this._stream(record, 'thinking', { delta: update.delta });
        }
        break;
      }
      case 'message_end':
        record.lastActivityTs = Date.now();
        // L2c detection: TRANSIENT account throttling (Zhipu 1302 etc.)
        // puts the runtime into backpressure. Permanent errors riding the
        // 429 status (1113 余额不足 = balance exhausted) must NOT — cooling
        // down cannot fix an empty account, it just looks like a hang.
        const errText = event.message?.errorMessage || '';
        if (event.message?.stopReason === 'error'
            && /429|1302|rate.?limit/i.test(errText)
            && !/1113|余额|balance|insufficient|quota/i.test(errText)) {
          noteRateLimit();
        }
        // Write-ahead: RAW message (full thinking/usage for context
        // restore) + meta piggyback, fsync'd before the journal fires.
        safeWalAppend(this.wal, {
          t: 'msg',
          d: {
            sid: record.id,
            msg: event.message,
            meta: this._metaOf(record),
          },
        });
        this._journal(record, 'message', normalizeMessage(event.message));
        break;
      case 'agent_end':
        record.busy = false;
        this._journal(record, 'agent_end', {
          messages: record.agent.state.messages.length,
        });
        // Counters/report meta may have moved during the run (submit tool)
        // without a trailing message — persist the final snapshot.
        safeWalAppend(this.wal, { t: 'meta', d: { sid: record.id, meta: this._metaOf(record) } });
        this._maybeSummarize(record);
        this._reportSpawnCompletion(record);
        // Synchronous tool callers (report_vulnerability → writer wait)
        // resolve here — event-driven, no polling, no timeout (agent_end
        // always fires, including error paths).
        for (const fn of record.completionWaiters ?? []) fn();
        record.completionWaiters = [];
        break;
      case 'tool_execution_start':
        this._journal(record, 'tool_start', {
          id: event.toolCallId,
          name: event.toolName,
          args: event.args,
        });
        break;
      case 'tool_execution_end':
        this._journal(record, 'tool_end', {
          id: event.toolCallId,
          result: truncateText(event.result),
        });
        break;
      default:
        break;
    }
  }
}
