#!/usr/bin/env node
/**
 * SPECTRE Agent Runtime entrypoint / composition root.
 *
 * Hosts pi sessions + the message bus + Temporal workflow triggers on
 * 127.0.0.1 only. Public traffic reaches it exclusively through the auth
 * gateway's reverse proxy (/spectre/api/*).
 *
 * Tool capabilities (dispatch / signal / bus / followUp) are assembled HERE
 * and injected into SessionStore, keeping sessions.mjs and tools.mjs free
 * of Temporal and bus imports (architecture rule: deps at the root).
 */

import http from 'node:http';

import { CONFIG } from './src/config.mjs';
import { Bus } from './src/bus.mjs';
import { createRouter } from './src/routes.mjs';
import { SessionStore } from './src/sessions.mjs';
import { buildPi } from './src/pi.mjs';
import { describeWorkflow, signalEngagement, startAutopwn } from './src/temporal.mjs';
import { Summarizer } from './src/summarizer.mjs';
import { getSpawnSettings } from './src/settings.mjs';
import { Wal } from './src/persist.mjs';
import path from 'node:path';

const { model, streamFn } = buildPi();
const wal = new Wal(path.join(CONFIG.dataDir, 'state.wal'));
wal.open();

// Boot recovery: replay the WAL (sessions + transcripts + bus) before the
// server accepts traffic, then compact the log atomically.
const { entries, truncated } = wal.readAll();
if (truncated) {
  console.warn('[runtime] WAL torn tail detected (crash mid-write) — dropped');
}
const replay = { records: new Map(), busEvents: [] };
for (const e of entries) {
  if (e.t === 'sess') {
    replay.records.set(e.d.id, { shell: e.d, messages: e.m ?? [], meta: e.meta ?? {} });
  } else if (e.t === 'msg') {
    const r = replay.records.get(e.d.sid);
    if (r) {
      r.messages.push(e.d.msg);
      Object.assign(r.meta, e.d.meta ?? {});
    }
  } else if (e.t === 'meta') {
    const r = replay.records.get(e.d.sid);
    if (r) Object.assign(r.meta, e.d.meta ?? {});
  } else if (e.t === 'bus') {
    replay.busEvents.push(e.d);
  }
}
const bus = new Bus(wal);
bus.load(replay.busEvents);

const caps = {
  dispatch: (input) => startAutopwn(input),
  signalEngagement,
  emitBus: (entry) => bus.emit(entry),
  followUp: (sessionId, text) => {
    const record = store.get(sessionId);
    if (!record) {
      throw Object.assign(new Error(`no orchestrator session ${sessionId}`),
        { statusCode: 404 });
    }
    store.followUp(record, text);
  },
  /** Read the last N messages of a session (read_session tool backing). */
  readSessionMessages: (sessionId, last) => {
    const record = store.get(sessionId);
    if (!record) return null;
    return record.agent.state.messages.slice(-last)
      .map(m => ({ role: m.role, text: typeof m.content === 'string'
        ? m.content
        : (m.content?.filter?.(c => c.type === 'text')
          ?.map(c => c.text)?.join('') || '') }));
  },
  /** Provenance snapshot for intel events (delegates to SessionStore). */
  authorOf: (record) => store.authorOf(record),
  /** Full bus journal read for query_intel (work-session filter applied tool-side). */
  listBus: () => bus.list(),

  /** Dispatch-tree spawn policy check (settings.mjs limits).
   *  Quota counts ACTIVE sessions only (Fix-C): completed = filed a
   *  task report AND no run in flight. Report the counting basis and
   *  recovery paths in the refusal (Fix-D/P3) so agents stop guessing
   *  whether slots free up. */
  spawnCheck: (parentRecord, agentKey) => {
    const { spawnMaxDepth, spawnMaxAgents } = getSpawnSettings();
    const rootId = store.rootIdOf(parentRecord.id);
    const childDepth = store.depthOf(parentRecord.id) + 1;
    const active = store.countTree(rootId, { activeOnly: true });
    const total = store.countTree(rootId);
    if (childDepth > spawnMaxDepth) {
      return { ok: false, reason:
        `深度上限 ${spawnMaxDepth}(当前将到第 ${childDepth} 层)`,
        depth: childDepth, active, total };
    }
    if (active + 1 > spawnMaxAgents) {
      return { ok: false, reason:
        `活跃智能体上限 ${spawnMaxAgents}(当前活跃 ${active}/历史 ${total}` +
        `——已提交任务报告的空闲会话不计入名额)。可等待在途任务完成后` +
        `重试,或经控制台调整 spawnMaxAgents。`,
        depth: childDepth, active, total };
    }
    return { ok: true, depth: childDepth, active, total };
  },

  /** Bulk quota check for dispatch_agents (Fix-B/A1): the dispatch entry
   *  point previously bypassed the quota entirely — it accepted a batch
   *  that pushed the tree over the cap, after which every spawn was
   *  locked out (project-3: tree 7 + 3 dispatched = 10 > 8 accepted).
   *  check→start has an inherent async window (ms-scale start, s-scale
   *  session landing); overshoot is bounded by one in-flight batch and
   *  self-heals once the sessions register — strictly better than none. */
  dispatchCheck: (parentRecord, count) => {
    const { spawnMaxAgents } = getSpawnSettings();
    const rootId = store.rootIdOf(parentRecord.id);
    const active = store.countTree(rootId, { activeOnly: true });
    const total = store.countTree(rootId);
    if (active + count > spawnMaxAgents) {
      return { ok: false, reason:
        `活跃智能体上限 ${spawnMaxAgents}(当前活跃 ${active}/历史 ${total}。` +
        `本批需 ${count} 个名额,超出 ${active + count - spawnMaxAgents}。` +
        `可分批派发、等待在途任务完成,或经控制台调高 spawnMaxAgents。`,
        active, total };
    }
    return { ok: true, active, total };
  },

  /** Fix-E (P7): member roster for explicit-engagementId relay calls. */
  engagementMembers: (engagementId) => store.engagementMembersOf(engagementId),
  describeEngagement: (workflowId) => describeWorkflow(workflowId),

  /**
   * Runtime-side recursive spawn: creates the child session inside the
   * spawner's tree (inherits project + engagement context; reports flow to
   * the SPAWNER, not the root), prompts it, and returns immediately.
   */
  spawnChild: (parentRecord, agentKey, instruction, meta = {}) => {
    const child = store.create(agentKey, {
      engagementId: parentRecord.engagementId ?? null,
      parentSessionId: parentRecord.id,
      // non-orchestrator spawns report to their spawner
      orchestratorSessionId: agentKey === 'autopwn'
        ? null : parentRecord.id,
      workSessionId: parentRecord.workSessionId ?? null,
      name: meta.name,
      description: meta.description,
    });
    bus.emit({
      channel: 'dm', from: parentRecord.agentKey, to: agentKey,
      type: 'spawn',
      summary: `派生 ${meta.name ?? agentKey}(${agentKey},` +
        `深度 ${store.depthOf(child.id)}):${instruction.slice(0, 90)}`,
      workSessionId: parentRecord.workSessionId ?? null,
    });
    store.prompt(child,
      `【派生任务 · ${agentKey}】${instruction}`, 'system');
    return child;
  },

  /**
   * Vulnerability-writer wake (report_vulnerability tool backing).
   * Creates a DETACHED writer session — no parentSessionId, no
   * engagementId, no orchestratorSessionId — so it never joins any
   * dispatch tree (parentNodeId null ⇒ rootIdOf = itself ⇒ countTree
   * and DispatchTreePanel ignore it) and never touches spawn quotas.
   * Synchronous: resolves at the writer's agent_end (event-driven, no
   * timeout — agent_end always fires, error paths included). Verdict:
   * the writer's published vulnerability event, or its decline reason.
   */
  reportWriter: async (requesterRecord, hint) => {
    const requesterAuthor = store.authorOf(requesterRecord);
    const writer = store.create('report', {
      workSessionId: requesterRecord.workSessionId ?? null,
      name: `报告:${String(hint).slice(0, 20)}`,
      description: `漏洞线索:${String(hint).slice(0, 60)}`,
    });
    // Frozen requester provenance — rides on the writer's published
    // vulnerability events (discoverer attribution).
    writer.requester = { sessionId: requesterRecord.id, author: requesterAuthor };
    const baseSeq = bus.list().at(-1)?.seq ?? 0;
    store.prompt(writer,
      `【漏洞报告撰写】你是报告撰写专职 agent。发现者 ${requesterAuthor.name}` +
      `(${requesterAuthor.typeLabel})在会话 ${requesterRecord.id} 中上报了漏洞线索:\n` +
      `「${hint}」\n\n` +
      `流程:\n` +
      `1) 用 read_session 读会话 ${requesterRecord.id}(建议 last=30)还原发现过程与证据;\n` +
      `2) 需要时用 query_intel 交叉验证项目内情报,或 read_session 其它相关会话;\n` +
      `3) 判定该线索是否构成真实危害、可提交的漏洞;\n` +
      `4) 成立 → 调用 publish_vulnerability 落账:自行拟定标题与 severity,` +
      `正文包含发现过程、证据链、危害分析与复现要点,并注明发现者 ${requesterAuthor.name};\n` +
      `   不成立 → 不发布,在最终回复中明确说明判定理由(该理由将回执给发现者);\n` +
      `5) 用 submit_task_report 提交任务报告收尾。`, 'system');
    await store.awaitCompletion(writer);
    const published = bus.list().find(e => e.seq > baseSeq
      && e.type === 'vulnerability' && e.author?.sessionId === writer.id);
    if (published) {
      return {
        ok: true,
        text: `漏洞报告已产出并入库:《${published.title}》` +
          `(severity=${published.severity},seq=${published.seq})。` +
          `撰写对话 ${writer.id}(read_session 可复盘其思考与验证过程)。`,
        details: { sessionId: writer.id, seq: published.seq,
          title: published.title, severity: published.severity },
      };
    }
    // Declined / failed: relay the writer's final reasoning back.
    const msgs = writer.agent.state.messages;
    const textOf = m => typeof m.content === 'string' ? m.content
      : (m.content?.filter?.(c => c.type === 'text')
        ?.map(c => c.text)?.join('') ?? '');
    const last = [...msgs].reverse()
      .find(m => m.role === 'assistant' && textOf(m).trim());
    const reply = last ? textOf(last) : '';
    return {
      ok: false,
      text: `报告agent未将此线索立为漏洞。其判定说明:\n` +
        `${(reply || '(无输出)').slice(0, 600)}\n` +
        `(撰写对话 ${writer.id};若你有更强证据可再次上报,` +
        `或用 publish_intel 留存线索)`,
      details: { sessionId: writer.id, declined: true },
    };
  },
};

const store = new SessionStore({ model, streamFn, caps, wal,
  summarizer: new Summarizer({ model, streamFn }) });
store.rehydrate([...replay.records.values()]);
if (replay.records.size || replay.busEvents.length) {
  console.log(`[runtime] recovered ${replay.records.size} sessions, ` +
    `${replay.busEvents.length} bus events from WAL`);
}
const compactWal = () => wal.compact([
  ...store.snapshotForDisk(),
  ...bus.list().map(e => ({ t: 'bus', d: e })),
]);
compactWal();
process.on('SIGTERM', () => {
  try { compactWal(); wal.close(); } catch { /* best effort */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
const route = createRouter({ store, bus });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    await route(req, res, url);
  } catch (err) {
    const code = err.statusCode || 500;
    if (code >= 500) {
      console.error(`[runtime] ${req.method} ${url.pathname}:`, err);
    }
    if (!res.headersSent) {
      const body = JSON.stringify({ error: err.message });
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
    } else {
      res.end();
    }
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`[agent-runtime] http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`[agent-runtime] model=${CONFIG.llmModel} temporal=${CONFIG.temporalAddress}`);
});
