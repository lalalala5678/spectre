/**
 * HTTP routing for the agent runtime.
 *
 * Route handlers stay small: parse, authorize, delegate to SessionStore /
 * Bus / Temporal modules. Public (console) routes vs internal (Temporal
 * activity) routes are separated below.
 */

import { AGENTS, isAgentKey } from './agents.mjs';
import { CONFIG } from './config.mjs';
import { hasInternalToken, json, readJson, sse } from './http.mjs';
import { describeWorkflow, startAutopwn } from './temporal.mjs';
import { getSpawnSettings, setSpawnSettings } from './settings.mjs';
import { injectionOriginOf } from './sessions.mjs';
import { entryKind as entryKindOf } from './tools.mjs';
import { emitRevision } from './revision.mjs';

const SESSION_ID = /^\/api\/sessions\/([a-z0-9-]+)(\/[a-z-]+)?$/;

function bad(res, code, message) {
  json(res, code, { error: message });
}

function requireFields(res, body, fields) {
  for (const field of fields) {
    if (!body[field]) {
      bad(res, 400, `${field} required`);
      return false;
    }
  }
  return true;
}

/**
 * @param {{store: import('./sessions.mjs').SessionStore,
 *          bus: import('./bus.mjs').Bus}} deps
 */
export function createRouter({ store, bus, caps }) {
  return async function route(req, res, url) {
    const path = url.pathname;
    const method = req.method;

    // ---------- spawn policy settings (console-editable) ----------
    if (path === '/api/settings' && method === 'GET') {
      return json(res, 200, getSpawnSettings());
    }
    if (path === '/api/settings' && method === 'PUT') {
      const body = await readJson(req);
      return json(res, 200, setSpawnSettings(body));
    }

    // ---------- health & registry ----------
    if (path === '/api/health') {
      return json(res, 200, {
        ok: true,
        model: CONFIG.llmModel,
        sessions: store.list().length,
        bus: bus.list().length,
      });
    }
    if (path === '/api/agents' && method === 'GET') {
      return json(res, 200, AGENTS.map(a => ({
        ...a,
        sessions: store.list().filter(s => s.agentKey === a.key).length,
      })));
    }

    // ---------- sessions (console + internal) ----------
    if (path === '/api/sessions' && method === 'GET') {
      return json(res, 200, store.list());
    }
    if (path === '/api/sessions' && method === 'POST') {
      const body = await readJson(req);
      if (!requireFields(res, body, ['agentKey']) || !isAgentKey(body.agentKey)) {
        return bad(res, 400, 'unknown agentKey');
      }
      // Engagement metadata marks AutoPwn children — internal only, a
      // console user must not forge orchestrator-linked sessions.
      // Engagement metadata marks AutoPwn children — internal only, a
      // console user must not forge orchestrator-linked sessions. The
      // workSessionId grouping key is ordinary user state.
      const opts = {};
      if (body.engagementId && hasInternalToken(req)) {
        opts.engagementId = String(body.engagementId);
        opts.orchestratorSessionId = body.orchestratorSessionId
          ? String(body.orchestratorSessionId) : null;
      }
      if (body.workSessionId) {
        opts.workSessionId = String(body.workSessionId).slice(0, 64);
      }
      if (body.parentSessionId) {
        opts.parentSessionId = String(body.parentSessionId).slice(0, 64);
      }
      if (body.name) {
        opts.name = String(body.name).slice(0, 30);
      }
      if (body.description) {
        opts.description = String(body.description).slice(0, 80);
      }
      const record = store.create(body.agentKey, opts);
      // Full summary: clients merge the response straight into session
      // lists (createdAt/messages/busy are load-bearing for sorting).
      return json(res, 201, store.summary(record));
    }

    const match = path.match(SESSION_ID);
    if (match) {
      const record = store.get(match[1]);
      const action = match[2] || '';
      if (!record) {
        return bad(res, 404, 'no such session');
      }

      if (!action && method === 'GET') {
        return json(res, 200, store.summary(record));
      }
      if (action === '/events' && method === 'GET') {
        const since = Number(url.searchParams.get('since') || 0);
        return store.attach(record, sse(req, res), since);
      }
      if (action === '/followup' && method === 'POST') {
        if (!hasInternalToken(req)) {
          return bad(res, 401, 'internal only');
        }
        const body = await readJson(req);
        const text = String(body.text || '').slice(0, CONFIG.maxPromptChars);
        if (!text) {
          return bad(res, 400, 'text required');
        }
        store.followUp(record, text);
        return json(res, 202, { ok: true });
      }
      if ((action === '/messages' || action === '/steer') && method === 'POST') {
        const body = await readJson(req);
        const text = String(body.text || '').slice(0, CONFIG.maxPromptChars);
        if (!text) {
          return bad(res, 400, 'text required');
        }
        // Agent-impersonating injections (Temporal activities) need the
        // internal token; plain console users ride their own session auth.
        if (body.source === 'agent' && !hasInternalToken(req)) {
          return bad(res, 401, 'agent source requires internal token');
        }
        try {
          // body.source==='agent' marks Temporal-side injections (internal
          // token enforced above); classify their origin so the console
          // never renders them as the human user.
          const source = body.source === 'agent'
            ? injectionOriginOf(text) : undefined;
          if (action === '/messages') {
            store.prompt(record, text, source);
          } else {
            store.steer(record, text, source);
          }
        } catch (err) {
          return bad(res, err.statusCode || 500, err.message);
        }
        return json(res, 202, { ok: true });
      }
      if (action === '/wait-idle' && method === 'POST') {
        if (!hasInternalToken(req)) {
          return bad(res, 401, 'internal only');
        }
        return json(res, 200, await store.waitIdle(record));
      }
      if (action === '/report-state' && method === 'GET') {
        if (!hasInternalToken(req)) {
          return bad(res, 401, 'internal only');
        }
        // Workflow-side task-report gate reads this (agentTaskWorkflow).
        return json(res, 200, {
          count: record.taskReportCount,
          author: store.authorOf(record),
          lastReport: record.lastReport,
        });
      }
      if (action === '/mark-report-synthesized' && method === 'POST') {
        if (!hasInternalToken(req)) {
          return bad(res, 401, 'internal only');
        }
        // Workflow-synthesized fallback report: bump the counter so the
        // activeOnly spawn quota releases the slot (P2 fix closing leg).
        const meta = await readJson(req);
        store.markReportSynthesized(record, meta);
        return json(res, 200, { count: record.taskReportCount });
      }
    }

    // ---------- bus ----------
    if (path === '/api/bus' && method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      return json(res, 200, bus.list(since));
    }
    if (path === '/api/bus/events' && method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      return bus.attach(sse(req, res), since);
    }
    if (path === '/api/bus' && method === 'POST') {
      if (!hasInternalToken(req)) {
        return bad(res, 401, 'internal only');
      }
      const body = await readJson(req);
      if (!requireFields(res, body, ['channel', 'from', 'summary'])) {
        return;
      }
      return json(res, 201, bus.emit(body));
    }

    // ---------- entry revision (console) ----------
    // Direct user edit: human is the final authority — lands immediately.
    if (path === '/api/bus/revise' && method === 'POST') {
      const body = await readJson(req);
      const target = bus.list().find(e => e.seq === Number(body.seq)
        && !e.revises && e.workSessionId === (body.workSessionId ?? e.workSessionId));
      if (!target) {
        return bad(res, 404, 'entry not found');
      }
      const fields = {};
      for (const k of ['title', 'severity', 'status', 'text']) {
        if (body[k] !== undefined) fields[k] = body[k];
      }
      if (!Object.keys(fields).length) {
        return bad(res, 400, 'nothing to revise');
      }
      const event = emitRevision(bus, {
        target, fields, reason: String(body.reason || '用户直接编辑'),
        requestedBy: { key: 'user', name: '用户', typeLabel: '人工',
          treePath: '用户', depth: 0 },
        approvedBy: { key: 'user', name: '用户', typeLabel: '人工',
          treePath: '用户', depth: 0 },
        origin: 'user',
      });
      return json(res, 201, event);
    }
    // Dialog revision: route to the writer. Vulns → the ORIGINAL writer
    // session (payloadRef, keeps its verification context); notes and
    // reports → a fresh report agent.
    if (path === '/api/bus/revise-request' && method === 'POST') {
      const body = await readJson(req);
      const instruction = String(body.instruction || '').slice(0, 2000);
      if (!instruction) {
        return bad(res, 400, 'instruction required');
      }
      const target = bus.list().find(e => e.seq === Number(body.seq) && !e.revises);
      if (!target) {
        return bad(res, 404, 'entry not found');
      }
      const kind = entryKindOf(target);
      if (kind === 'vulnerability' && target.payloadRef?.startsWith('sess:')) {
        const writerId = target.payloadRef.slice(5);
        try {
          store.followUp(store.get(writerId),
            `【用户修订请求 · seq=${target.seq}】用户要求修订你撰写的漏洞` +
            `《${target.title}》:\n『${instruction}』\n` +
            `请审核该请求的必要性与正确性(可用 read_session/query_intel 求证),` +
            `认可后调用 revise_entry(seq=${target.seq}, reason=..., ` +
            `title/severity/text 按核定结果)落账;不认可则在回复中说明理由。`, 'system');
          return json(res, 202, { mode: 'original-writer', sessionId: writerId });
        } catch {
          // original writer session gone — fall through to fresh writer
        }
      }
      // Fresh writer for notes / reports / fallback.
      const writer = store.create('report', {
        workSessionId: target.workSessionId ?? null,
        name: `修订:${String(target.title ?? '').slice(0, 20)}`,
        description: `用户对话框修订:${instruction.slice(0, 60)}`,
      });
      store.prompt(writer,
        `【条目修订 · seq=${target.seq}】你是报告撰写专职 agent。用户要求修订以下` +
        `${kind === 'task-report' ? '任务报告' : kind === 'vulnerability' ? '漏洞' : '情报'}:` +
        `\n《${target.title}》\n现行内容:\n${target.detail ?? target.summary ?? '(空)'}\n\n` +
        `用户指令:『${instruction}』\n` +
        `请先判断指令是否清晰合理(需要时 query_intel/read_session 求证),` +
        `然后调用 revise_entry(seq=${target.seq}, reason='用户指令:...', ` +
        `按指令核定 title/text 等字段)落账;若指令不可执行或不合理,` +
        `在回复中说明。最后提交任务报告。`, 'system');
      return json(res, 202, { mode: 'fresh-writer', sessionId: writer.id });
    }

    // ---------- autopwn ----------
    if (path === '/api/autopwn' && method === 'POST') {
      const body = await readJson(req);
      const instruction = String(body.instruction || '').slice(0, 8000);
      const agents = (body.agents || []).filter(isAgentKey);
      if (!instruction || agents.length === 0) {
        return bad(res, 400, 'instruction and agents required');
      }
      const started = await startAutopwn({ engagementId: undefined, instruction, agents });
      return json(res, 201, started);
    }
    if (path === '/api/autopwn' && method === 'GET') {
      const workflowId = url.searchParams.get('workflowId');
      if (!workflowId) {
        return bad(res, 400, 'workflowId required');
      }
      try {
        const desc = await describeWorkflow(workflowId);
        return json(res, 200, { ...desc, bus: bus.list().filter(e => e.engagement === workflowId) });
      } catch (err) {
        return bad(res, 404, String(err));
      }
    }

    return bad(res, 404, 'not found');
  };
}
