/**
 * HTTP routing for the agent runtime.
 *
 * Route handlers stay small: parse, authorize, delegate to SessionStore /
 * Bus / Temporal modules. Public (console) routes vs internal (Temporal
 * activity) routes are separated below.
 */

import { AGENTS, AGENT_KEYS, isAgentKey } from './agents.mjs';
import { CONFIG } from './config.mjs';
import { hasInternalToken, json, readJson, readRawBody, parseMultipart, sse } from './http.mjs';
import * as path_mod from 'node:path';
import { describeWorkflow, startAutopwn } from './temporal.mjs';
import { getSpawnSettings, setSpawnSettings } from './settings.mjs';
import { injectionOriginOf } from './sessions.mjs';
import { entryKind as entryKindOf } from './tools.mjs';
import { emitRevision } from './revision.mjs';
import { sandboxConfig, saveSandboxConfig, ensureSandbox, installCli, listInstalledTools } from './sandbox/container.mjs';
import { listProjects, getProject, ensureProject, renameProject, createProject, setLastSession, getPrefs, setPrefs } from './projects.mjs';
import { saveSkill, deleteSkill, listSkillsTree } from './sandbox/skills.mjs';
import { loadMcpConfig, saveMcpConfig, testMcpServer } from './sandbox/mcp.mjs';

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
export function createRouter({ store, bus, caps, wal }) {
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
    // Tree-only projection: the dispatch panel polls every 4s and only
    // needs topology/state fields — 41KB full list → ~6KB per poll.
    if (path === '/api/sessions/tree' && method === 'GET') {
      return json(res, 200, store.list().map(s => ({
        id: s.id, agentKey: s.agentKey, title: s.title,
        createdAt: s.createdAt,
        engagementId: s.engagementId,
        orchestratorSessionId: s.orchestratorSessionId,
        parentSessionId: s.parentSessionId,
        workSessionId: s.workSessionId,
        spawnName: s.spawnName, busy: s.busy,
      })));
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
        // auto-register unknown project ids (sessions may arrive before
        // the console ever created the project)
        ensureProject(opts.workSessionId, wal);
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

    // ---------- projects & prefs (server-side; browser stores nothing) ----------
    if (path === '/api/projects' && method === 'GET') {
      return json(res, 200, listProjects());
    }
    if (path === '/api/projects' && method === 'POST') {
      const body = await readJson(req);
      // migration batch: {projects: [...]} registers legacy browser-side
      // entries verbatim (keeps ids so existing sessions stay grouped)
      if (Array.isArray(body.projects)) {
        for (const p of body.projects) {
          if (p?.id && !getProject(p.id)) {
            ensureProject(p.id, wal, String(p.label ?? '').slice(0, 60));
          }
        }
        return json(res, 201, listProjects());
      }
      const created = createProject(String(body.label ?? ''), wal);
      setPrefs({ currentWs: created.id }, wal);
      return json(res, 201, created);
    }
    const projMatch = path.match(/^\/api\/projects\/([a-z0-9-]+)$/);
    if (projMatch && method === 'PUT') {
      const pid = projMatch[1];
      const body = await readJson(req);
      const p = getProject(pid);
      if (!p) return bad(res, 404, 'project not found');
      if (body.label !== undefined) renameProject(pid, body.label, wal);
      if (body.agentKey && body.sessionId) {
        setLastSession(pid, body.agentKey, body.sessionId, wal);
      }
      return json(res, 200, getProject(pid));
    }
    if (path === '/api/prefs' && method === 'GET') {
      return json(res, 200, getPrefs());
    }
    if (path === '/api/prefs' && method === 'PUT') {
      const body = await readJson(req);
      return json(res, 200, setPrefs(body, wal));
    }

    // ---------- uploads (files land in the sandbox /opt/uploads) ----------
    if (path === '/api/sandbox/uploads' && method === 'POST') {
      const body = await readRawBody(req);
      const { fields, file } = parseMultipart(body,
        req.headers['content-type'] ?? '');
      if (!file) return bad(res, 400, 'file part required');
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { HOST } = await import('./sandbox/exec-env.mjs');
      const safeName = file.filename.slice(0, 120) || `upload-${Date.now()}`;
      await mkdir(HOST.uploads, { recursive: true });
      const target = path_mod.join(HOST.uploads, safeName);
      await writeFile(target, file.data);
      return json(res, 201, {
        sandboxPath: `/opt/uploads/${safeName}`,
        size: file.data.length, note: fields.note ?? null,
      });
    }

    // ---------- sandbox / skills / MCP / CLI management ----------
    if (path === '/api/sandbox/status' && method === 'GET') {
      const cfg = sandboxConfig();
      return json(res, 200, {
        ...cfg,
        dockerAvailable: cfg.driver === 'docker',
      });
    }
    if (path === '/api/sandbox/config' && method === 'PUT') {
      const body = await readJson(req);
      const cfg = await saveSandboxConfig({
        driver: ['docker', 'local'].includes(body.driver) ? body.driver : undefined,
        container: body.container ? String(body.container).slice(0, 80) : undefined,
        image: body.image ? String(body.image).slice(0, 200) : undefined,
      });
      const ensured = await ensureSandbox();
      const { rebuildMounts } = await import('./sandbox/mount.mjs');
      await rebuildMounts(AGENT_KEYS);
      return json(res, 200, { ...cfg, ensured });
    }
    if (path === '/api/sandbox/cli' && method === 'POST') {
      const body = await readJson(req);
      const cmd = String(body.command || '').trim();
      if (!cmd) return bad(res, 400, 'command required');
      const result = await installCli(cmd);
      return json(res, 200, result);
    }
    if (path === '/api/sandbox/tools' && method === 'GET') {
      return json(res, 200, await listInstalledTools());
    }
    // skills CRUD + per-agent mounts
    if (path === '/api/sandbox/skills' && method === 'GET') {
      return json(res, 200, await listSkillsTree(AGENT_KEYS));
    }
    if (path === '/api/sandbox/skills' && method === 'POST') {
      const body = await readJson(req);
      if (!body.agentKey || !body.name || !body.content) {
        return bad(res, 400, 'agentKey, name, content required');
      }
      const filePath = await saveSkill(body.agentKey, {
        name: String(body.name).slice(0, 60),
        description: String(body.description ?? '').slice(0, 200),
        content: String(body.content).slice(0, 50000),
      });
      const { rebuildMounts } = await import('./sandbox/mount.mjs');
      await rebuildMounts(AGENT_KEYS);
      return json(res, 201, { filePath });
    }
    if (path === '/api/sandbox/skills' && method === 'DELETE') {
      const url2 = new URL(req.url, 'http://x');
      const agentKey = url2.searchParams.get('agentKey');
      const name = url2.searchParams.get('name');
      if (!agentKey || !name) return bad(res, 400, 'agentKey, name required');
      await deleteSkill(agentKey, name);
      const { rebuildMounts } = await import('./sandbox/mount.mjs');
      await rebuildMounts(AGENT_KEYS);
      return json(res, 200, { deleted: true });
    }
    // MCP servers CRUD + test (remote http or stdio; future config-agent
    // edits the same store through this API)
    if (path === '/api/sandbox/mcp' && method === 'GET') {
      const list = await loadMcpConfig();
      // never leak header secrets wholesale — mask values
      return json(res, 200, list.map(s => ({
        ...s,
        headers: Object.fromEntries(Object.keys(s.headers ?? {})
          .map(k => [k, '***'])),
      })));
    }
    if (path === '/api/sandbox/mcp' && method === 'POST') {
      const body = await readJson(req);
      if (!body.name || !body.transport) {
        return bad(res, 400, 'name, transport required');
      }
      const entry = {
        name: String(body.name).slice(0, 60),
        transport: body.transport,
        agents: Array.isArray(body.agents) ? body.agents.filter(isAgentKey) : [],
        enabled: body.enabled !== false,
        ...(body.transport === 'http'
          ? { url: String(body.url ?? '').slice(0, 500),
              headers: body.headers ?? {} }
          : { command: body.command ?? [], env: body.env ?? {},
              where: body.where === 'sandbox' ? 'sandbox' : 'host' }),
      };
      const list = (await loadMcpConfig())
        .filter(s => s.name !== entry.name);
      const next = await saveMcpConfig([...list, entry]);
      const { rebuildMounts } = await import('./sandbox/mount.mjs');
      await rebuildMounts(AGENT_KEYS);
      return json(res, 201, next.find(s => s.name === entry.name));
    }
    if (path === '/api/sandbox/mcp' && method === 'DELETE') {
      const url2 = new URL(req.url, 'http://x');
      const name = url2.searchParams.get('name');
      const next = (await loadMcpConfig()).filter(s => s.name !== name);
      await saveMcpConfig(next);
      const { rebuildMounts } = await import('./sandbox/mount.mjs');
      await rebuildMounts(AGENT_KEYS);
      return json(res, 200, { deleted: true });
    }
    if (path === '/api/sandbox/mcp/test' && method === 'POST') {
      const body = await readJson(req);
      const server = (await loadMcpConfig())
        .find(s => s.name === body.name);
      if (!server) return bad(res, 404, 'server not found');
      // re-attach fresh headers when the caller is saving (secrets are
      // masked in GET; the console sends them back on save)
      if (body.headers) server.headers = body.headers;
      return json(res, 200, await testMcpServer(server));
    }

    // ---------- bus ----------
    if (path === '/api/bus' && method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      // Server-side project scoping: panels used to fetch the FULL bus
      // (292KB at 224 events) and filter client-side ×3 panels per switch.
      // ?ws= cuts the payload to the project's own entries.
      const ws = url.searchParams.get('ws');
      const events = bus.list(since);
      return json(res, 200, ws
        ? events.filter(e => e.workSessionId === ws) : events);
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
