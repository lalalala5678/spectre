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
import { createShellRegistry } from './src/shells.mjs';
import { readFileSync } from 'node:fs';
import { createRouter } from './src/routes.mjs';
import { SessionStore } from './src/sessions.mjs';
import { entryKind as entryKindOf } from './src/tools.mjs';
import { emitRevision } from './src/revision.mjs';
import { buildPi } from './src/pi.mjs';
import { describeWorkflow, signalEngagement, startAutopwn } from './src/temporal.mjs';
import { Summarizer } from './src/summarizer.mjs';
import { getSpawnSettings, spawnSettingsFromWal } from './src/settings.mjs';
import { makeSpawnPolicy } from './src/spawn-policy.mjs';
import { Wal } from './src/persist.mjs';
import { loadSandboxConfig, ensureSandbox } from './src/sandbox/container.mjs';
import { projectsFromWal, listProjects, getPrefs } from './src/projects.mjs';
import { AGENT_KEYS } from './src/agents.mjs';
import path from 'node:path';

const { model, streamFn } = await buildPi();
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
// project registry + prefs (server-side, browser stores nothing)
projectsFromWal(entries);
spawnSettingsFromWal(entries);  // F68: spawn policy WAL replay
const bus = new Bus(wal);
bus.load(replay.busEvents);

// Shell registry (C2 implant handles; transport 'local' for benchmark).
// Scope reader mirrors /opt/tools/c2/scope.json — server-side hard gate.
const shellScope = () => {
  // Read-per-call: benchmark windows open/close live; a boot-cached scope
  // would reject freshly authorized exercises.
  try { return JSON.parse(readFileSync('/var/lib/spectre/tools/c2/scope.json', 'utf8')); }
  catch { return null; }
};

const shellRegistry = createShellRegistry({ bus: { emit: (entry) => bus.emit({ type: 'shell-event', ...entry }) }, wal, listScope: shellScope });

const caps = {
  shells: shellRegistry,
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

  /* F66: 策略实现抽出至 src/spawn-policy.mjs(确定性边界测试)——行为零变更。 */
  spawnCheck: (r, k) => spawnPolicy.spawnCheck(r, k),
  dispatchCheck: (r, c) => spawnPolicy.dispatchCheck(r, c),

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
    await store.awaitCompletion(writer, 300_000);
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

  /** wake_agent tool backing — the mandatory post-config verification
   *  step: spawn a DETACHED business-agent session (no dispatch tree,
   *  no quota — same detach rules as the report writer), ask it to
   *  confirm its own toolface state, await its reply, return it. */
  wakeAgent: async (requesterRecord, agentKey, question) => {
    const target = store.create(agentKey, {
      workSessionId: requesterRecord.workSessionId ?? null,
      name: `唤醒验证:${agentKey}`,
      description: `配置验证:${String(question).slice(0, 60)}`,
    });
    store.prompt(target,
      `【配置验证】配置智能体 ${requesterRecord.agentKey} 刚完成了工具配置变更,需要你从自己的工具面确认状态。\n` +
      `问题:${question}\n\n` +
      `要求:只做验证本身——检查你的技能索引/工具清单,必要时实际调用一次,` +
      `把回执要点如实报告。不要展开其它任务。完成后一句话结论即可。`, 'system');
    await store.awaitCompletion(target, 300_000);
    const msgs = target.agent.state.messages;
    const textOf = m => typeof m.content === 'string' ? m.content
      : (m.content?.filter?.(c => c.type === 'text')
        ?.map(c => c.text)?.join('') ?? '');
    const last = [...msgs].reverse()
      .find(m => m.role === 'assistant' && textOf(m).trim());
    const reply = last ? textOf(last) : '(无输出)';
    return {
      ok: Boolean(last),
      text: `${agentKey} 的验证答复:\n${reply.slice(0, 1200)}\n` +
        `(验证会话 ${target.id},read_session 可复盘)`,
    };
  },

  /** revise_entry tool backing. Vuln targets: writer sessions only
   *  (enforcement point for the review mandate); notes/reports: any
   *  agent (shared working records — reason rides for audit). */
  reviseEntry: (callerRecord, params) => {
    // F33: 项目作用域——与 query_intel 同语义(e.ws === caller.ws ?? null)。
    // 此前无过滤: 跨项目 seq 可被修订(writer 自评空库负对照命中,
    // 审计链污染面)。
    const target = bus.list().find(e => e.seq === Number(params.seq)
      && entryKindOf(e) !== null && !e.revises
      && e.workSessionId === (callerRecord.workSessionId ?? null));
    if (!target) {
      return { text: `seq=${params.seq} 不在本项目可修订范围(不存在/他项目条目/已折叠)。` };
    }
    const kind = entryKindOf(target);
    if (kind === 'vulnerability' && callerRecord.agentKey !== 'report') {
      return { text: `seq=${params.seq} 是漏洞——漏洞修订必须经撰写agent审核。` +
        `请改用 request_vulnerability_revision(seq, reason, changes)提交申请。` };
    }
    const authorOfCaller = store.authorOf(callerRecord);
    // Writer reviewing a REQUEST carries the requester's provenance on its
    // record (revisionWriter sets it) — credit the requester, not the pen.
    const requestedBy = callerRecord.requester?.author ?? authorOfCaller;
    const event = emitRevision(bus, {
      target, fields: params, reason: params.reason,
      requestedBy, approvedBy: authorOfCaller,
      origin: callerRecord.agentKey === 'report' ? 'writer' : 'agent',
    });
    return {
      text: `修订已入库(seq=${target.seq} 第 ${event.revision.n} 次修订):` +
        `《${event.title ?? ''}》。原版保留在链上,query_intel 显示现行版。`,
      details: { revises: target.seq, n: event.revision.n },
    };
  },

  /** request_vulnerability_revision backing — writer review wake.
   *  Same detached-session + event-driven-wait pattern as reportWriter. */
  revisionWriter: async (requesterRecord, targetSeq, reason, changes) => {
    const target = bus.list().find(e => e.seq === Number(targetSeq)
      && entryKindOf(e) === 'vulnerability' && !e.revises
      && e.workSessionId === (requesterRecord.workSessionId ?? null));  // F33
    if (!target) {
      return { text: `seq=${targetSeq} 不是本项目漏洞原始条目,无法申请修订。` };
    }
    const chain = bus.list().filter(e => e.revises === target.seq);
    const current = chain.sort((a, b) => (b.revision?.n ?? 0) - (a.revision?.n ?? 0))[0];
    const requesterAuthor = store.authorOf(requesterRecord);
    const writer = store.create('report', {
      workSessionId: requesterRecord.workSessionId ?? null,
      name: `修订:${String(target.title ?? '').slice(0, 20)}`,
      description: `漏洞修订申请:${reason.slice(0, 60)}`,
    });
    writer.requester = { sessionId: requesterRecord.id, author: requesterAuthor };
    writer.revisionTarget = target.seq;
    store.prompt(writer,
      `【漏洞修订审核 · seq=${target.seq}】你是报告撰写专职 agent。` +
      `${requesterAuthor.name}(${requesterAuthor.typeLabel})申请修订漏洞:\n` +
      `『${target.title}』(severity=${target.severity ?? '?'},现行版内容如下)\n` +
      `---现行内容---\n${(current ?? target).detail ?? target.summary ?? '(空)'}\n---\n` +
      `申请理由:${reason}\n要求更改:${changes}\n\n` +
      `你的职责:\n` +
      `1) 判定必要性:该理由是否成立(可用 read_session 读申请者会话 ${requesterRecord.id} 求证);\n` +
      `2) 判定正确性:要求的内容是否准确、不会引入错误;\n` +
      `3) 两关都过 → 调用 revise_entry(seq=${target.seq}, reason=..., title/severity/text 按核定结果)落账修订;\n` +
      `   任一关不过 → 不落账,在最终回复中明确说明驳回理由(将回执给申请者);\n` +
      `4) 提交任务报告收尾。`, 'system');
    await store.awaitCompletion(writer, 300_000);
    const landed = bus.list().find(e => e.revises === target.seq
      && (e.revision?.n ?? 0) > ((current?.revision?.n) ?? 0));
    if (landed) {
      return {
        ok: true,
        text: `修订已获核准并入库:《${landed.title}》(severity=${landed.severity},` +
          `第 ${landed.revision.n} 次修订,seq=${target.seq})。` +
          `审核对话 ${writer.id}。`,
        details: { sessionId: writer.id, revises: target.seq, n: landed.revision.n },
      };
    }
    const textOf = m => typeof m.content === 'string' ? m.content
      : (m.content?.filter?.(c => c.type === 'text')
        ?.map(c => c.text)?.join('') ?? '');
    const last = [...writer.agent.state.messages].reverse()
      .find(m => m.role === 'assistant' && textOf(m).trim());
    return {
      ok: false,
      text: `撰写agent驳回了该修订申请。其说明:\n` +
        `${((last && textOf(last)) || '(无输出)').slice(0, 600)}\n` +
        `(审核对话 ${writer.id})`,
      details: { sessionId: writer.id, declined: true },
    };
  },
};

const store = new SessionStore({ model, streamFn, caps, wal,
  summarizer: new Summarizer({ model, streamFn }) });
const spawnPolicy = makeSpawnPolicy(store);
store.rehydrate([...replay.records.values()]);
if (replay.records.size || replay.busEvents.length) {
  console.log(`[runtime] recovered ${replay.records.size} sessions, ` +
    `${replay.busEvents.length} bus events from WAL`);
}
// ---- sandbox layer boot (driver detect → container/dirs → mounts) ----
loadSandboxConfig().then(async cfg => {
  const ensured = await ensureSandbox();
  console.log(`[sandbox] driver=${cfg.driver} ok=${ensured.ok}`,
    ensured.error ?? '');
  const { rebuildMounts } = await import('./src/sandbox/mount.mjs');
  await rebuildMounts(AGENT_KEYS);
  console.log('[sandbox] skill/MCP mounts warmed');
}).catch(err => console.warn('[sandbox] boot degraded:', err.message));

const compactWal = () => wal.compact([
  ...store.snapshotForDisk(),
  ...bus.list().map(e => ({ t: 'bus', d: e })),
  ...listProjects().map(p => ({ t: 'proj', d: p })),
  { t: 'pref', d: getPrefs() },
  { t: 'spawn', d: getSpawnSettings() },  // F68: compact 白名单补 spawn
]);
compactWal();
process.on('SIGTERM', () => {
  try { compactWal(); wal.close(); } catch { /* best effort */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
const route = createRouter({ store, bus, caps, wal });

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
