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
import { signalEngagement, startAutopwn } from './src/temporal.mjs';
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

  /** Dispatch-tree spawn policy check (settings.mjs limits). */
  spawnCheck: (parentRecord, agentKey) => {
    const { spawnMaxDepth, spawnMaxAgents } = getSpawnSettings();
    const rootId = store.rootIdOf(parentRecord.id);
    const childDepth = store.depthOf(parentRecord.id) + 1;
    const treeSize = store.countTree(rootId);
    if (childDepth > spawnMaxDepth) {
      return { ok: false, reason:
        `深度上限 ${spawnMaxDepth}(当前将到第 ${childDepth} 层)`,
        depth: childDepth, treeSize };
    }
    if (treeSize + 1 > spawnMaxAgents) {
      return { ok: false, reason:
        `数量上限 ${spawnMaxAgents}(当前树已有 ${treeSize} 个智能体)`,
        depth: childDepth, treeSize };
    }
    return { ok: true, depth: childDepth, treeSize };
  },

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
