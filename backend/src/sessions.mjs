/**
 * pi session store.
 *
 * One pi Agent instance per session. Every agent event is journaled with a
 * monotonic sequence number and fanned out to that session's SSE subscribers.
 * Sessions are in-memory in this phase; pi state survives in the Agent
 * object for the process lifetime.
 */

import crypto from 'node:crypto';

import { Agent } from '@earendil-works/pi-agent-core';

import { CONFIG } from './config.mjs';
import { typeLabelOf } from './agents.mjs';
import { effectiveCommon } from './agent-settings.mjs';
import { ORCHESTRATOR_PROMPT, STAGE_PROMPT, RECON_PROMPT, NDAY_PROMPT, TOOLS_GUIDE, SKILL_CONFIG_PROMPT, MCP_CONFIG_PROMPT, CLI_CONFIG_PROMPT, clipMarked, normalizeMessage, noteRateLimit, truncateText } from './pi.mjs';
import { formatSkillsForSystemPrompt } from '@earendil-works/pi-agent-core';
import { mountForSession, skillsCached } from './sandbox/mount.mjs';

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
};
import { buildChildTools, buildDirectTools, buildIntelTools, buildOrchestratorTools } from './tools.mjs';
import { Summarizer } from './summarizer.mjs';

const ORCHESTRATOR_KEY = 'autopwn';

/**
 * Report nudge text — twin constant lives in workflows.mjs (architecture
 * rule: workflows must not import runtime modules).
 */
const REPORT_NUDGE_TEXT = '【系统要求】本段运行尚未提交任务报告。请立即调用 ' +
  'submit_task_report(字段:title/task/actions/outcome;status 建议填写,' +
  '遗漏时系统会按 outcome 推断),说明做了什么、结果或失败原因与全部必要信息——' +
  '即使没有任何发现也必须提交。这是结束任务的必要条件;提交后本任务即告完成。';


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
   * @param {{engagementId?: string, orchestratorSessionId?: string}} [opts]
   *   engagement metadata marks the session as an AutoPwn child; those
   *   sessions carry the publish_vulnerability / publish_intel tools.
   */
  create(agentKey, opts = {}) {
    const id = `sess-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const isOrchestrator = agentKey === ORCHESTRATOR_KEY;
    // Tree membership: workflow engagement children carry engagementId;
    // runtime-spawned descendants carry parentSessionId (and may have neither
    // engagementId nor an orchestrator ancestor beyond the root session).
    const hasParent = Boolean(opts.engagementId || opts.parentSessionId);
    const isEngagementChild = hasParent && !isOrchestrator;
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
      spawnName: record.spawnName,
      spawnDescription: record.spawnDescription,
      spawnReports: record.spawnReports,
      taskReportCount: record.taskReportCount,
      reportNudges: record.reportNudges,
      lastReport: record.lastReport,
    };
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
    const base = isOrchestrator
      ? [
        ...buildOrchestratorTools(record, this.caps),
        ...buildChildTools(record, this.caps).filter(t => t.name !== 'spawn_agent'),
        ...buildIntelTools(record, this.caps),
      ]
      : hasParent
        ? [...buildChildTools(record, this.caps), ...buildIntelTools(record, this.caps)]
        : [...buildDirectTools(record, this.caps),
          ...buildIntelTools(record, this.caps)];
    // Sandbox layer: official bash/read/write/edit (ExecutionEnv-bound,
    // project cwd) + per-agent MCP tools + per-agent skill index.
    const mount = mountForSession(record.agentKey, record.workSessionId);
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
          (skillIndexBlock ? `\n\n${skillIndexBlock}` : ''),
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
        // one poisoned record must never abort the whole boot — skip
        // and keep going (the session stays inert rather than fatal)
        console.error(`[rehydrate] skip session ${record.id}:`, e?.message ?? e);
        record.agent = null;
      }
      this.sessions.set(record.id, record);
    }
  }

  /** Current state for WAL compaction (boot/shutdown rewrite). */
  snapshotForDisk() {
    return [...this.sessions.values()].map(s => ({
      t: 'sess',
      d: this._shellOf(s),
      m: s.agent.state.messages,
      meta: {
        brief: s.brief,
        briefUpTo: s.briefUpTo,
        lastActivityTs: s.lastActivityTs,
      },
    }));
  }

  /** Mutable meta tracked across messages (piggybacked on WAL entries). */
  _metaOf(record) {
    return {
      title: record.title,
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

  /**
   * Display title projection: the LLM one-shot title when present, else a
   * first-user-message excerpt. Projection only — record.title stays null
   * until the summarizer sets it, so the `!record.title` generation gate
   * (and the `<title/>` decline path) is unaffected.
   */
  _displayTitle(record) {
    if (record.title) return record.title;
    const first = record.agent.state.messages.find(m => m.role === 'user');
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
      createdAt: s.createdAt,
      busy: s.busy,
      messages: s.agent.state.messages.length,
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
      createdAt: record.createdAt,
      busy: record.busy,
      engagementId: record.engagementId,
      spawnName: record.spawnName,
      spawnDescription: record.spawnDescription,
      messages: record.agent.state.messages.map(m => normalizeMessage(m)),
      // SSE cursor: clients subscribe with ?since=lastSeq to avoid
      // replaying the history they just fetched.
      brief: record.brief,
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
    if (record.busy) {
      throw Object.assign(new Error('agent busy; use steer'), { statusCode: 409 });
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
          record.busy = false;  // run never started — don't strand waitIdle
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
    const head = msgs.slice(0, msgs.length - tail.length);
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
    this._journal(record, 'compaction', {
      summarized: head.length, kept: tail.length,
      tokensBefore: ctx, tokensAfter: '~' + Math.ceil(summaryText.length / 4),
    });
  }

  /** Queue a steering message for delivery after the current turn. */
  steer(record, text, source) {
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
      record.busy = false;
      queue();
    });
  }

  async waitIdle(record) {
    const deadline = Date.now() + CONFIG.maxIdleWaitMs;
    while (record.busy && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
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
      client.write(frame);
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

  /**

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
    if (!this.summarizer || record.summarizeBusy) return;
    const run = async (job) => {
      record.summarizeBusy = true;
      try {
        await job();
      } catch (err) {
        console.error(`[summarizer] ${record.id}:`, String(err));
      } finally {
        record.summarizeBusy = false;
      }
    };
    if (!record.title) {
      run(() => this.summarizer.generateTitle(record));
      return;
    }
    const cfg = {
      minDelta: CONFIG.summaryMinDelta,
      eagerDelta: CONFIG.summaryEagerDelta,
      idleMs: CONFIG.summaryIdleMs,
    };
    if (Summarizer.shouldRefreshBrief(record, cfg)) {
      run(() => this.summarizer.refreshBrief(record));
    } else if (record.agent.state.messages.length - record.briefUpTo
               >= cfg.minDelta) {
      const delay = Math.max(0,
        cfg.idleMs - (Date.now() - record.lastActivityTs));
      setTimeout(() => {
        // still idle since schedule time and still enough new material
        const stillDelta = record.agent.state.messages.length - record.briefUpTo;
        if (record.busy || record.summarizeBusy || stillDelta < cfg.minDelta) {
          return;
        }
        run(() => this.summarizer.refreshBrief(record));
      }, delay);
    }
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
