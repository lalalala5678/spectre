/**
 * HTTP routing for the agent runtime.
 *
 * Route handlers stay small: parse, authorize, delegate to SessionStore /
 * Bus / Temporal modules. Public (console) routes vs internal (Temporal
 * activity) routes are separated below.
 */

import { AGENTS, AGENT_KEYS, isAgentKey } from './agents.mjs';
import { SPAWNABLE_KEYS, STAGE_KEYS, entryKind as entryKindOf } from './tools.mjs';
import { CONFIG } from './config.mjs';
import { hasInternalToken, isInternalCaller, json, readJson, readRawBody, parseMultipart, sse } from './http.mjs';
import * as path_mod from 'node:path';
import { describeWorkflow, startAutopwn } from './temporal.mjs';
import { getSpawnSettings, setSpawnSettings } from './settings.mjs';
import { injectionOriginOf } from './sessions.mjs';
import { emitRevision } from './revision.mjs';
import { sandboxConfig, saveSandboxConfig, ensureSandbox, installCli, listInstalledTools, sharedLayerTools, uninstallCliTool } from './sandbox/container.mjs';
import { listProjects, getProject, ensureProject, renameProject, createProject, setLastSession, getPrefs, setPrefs, deleteProject, isTombstoned } from './projects.mjs';
import { saveSkill, deleteSkill, listSkillsTree, readSkillContent } from './sandbox/skills.mjs';
import { applyMcpAndMounts } from './sandbox/apply-config.mjs';
import { syncSourceKeyFiles } from './keyfiles.mjs';
import { phishCampaignFunnel } from './phish-funnel.mjs';
import { loadMcpConfig, testMcpServer } from './sandbox/mcp.mjs';
import { getSettings, saveSetting, hasSourceCredential, RECON_SOURCES_INTERNAL } from './agent-settings.mjs';
import { applyLlmPrefs } from './pi.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { HOST } from './sandbox/exec-env.mjs';

const SESSION_ID = /^\/api\/sessions\/([a-z0-9-]+)(\/[a-z-]+)?$/;
const PROJECT_ID = /^\/api\/projects\/([a-z0-9-]+)$/;  // CS3-N22: PUT/DELETE 双胞胎正则单源

function bad(res, code, message) {
  json(res, code, { error: message });
}

function requireFields(res, body, fields) {
  for (const field of fields) {
    if (!body[field]) {
      bad(res, 400, `${field} 必填`);
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
  // Uniform auth gate: EVERY /api route except /api/health requires the
  // internal token. Previously only 3 endpoints checked it — every other
  // route was reachable unauthenticated by any local process (in the
  // local driver an agent's bash could bypass ALL tool governance by
  // curling 127.0.0.1:8090 directly). The gateway injects the token on
  // behalf of authenticated console sessions; temporal workers already
  // send it via runtime-client.
  const route = realRouter({ store, bus, caps, wal });
  return async function gatedRoute(req, res, url) {
    if (url.pathname !== '/api/health' && !hasInternalToken(req)) {
      return json(res, 401, { error: '需要内部令牌' });
    }
    return route(req, res, url);
  };
}

function realRouter({ store, bus, caps, wal }) {
  const route = async function route(req, res, url) {
    const path = url.pathname;
    const method = req.method;

    // ---------- shells (C2 implant handles: list/register/exec/close) ----------
    if (path === '/api/shells' && method === 'GET') {
      return json(res, 200, { shells: caps.shells.list() });
    }
    if (path === '/api/shells' && method === 'POST') {
      const body = await readJson(req);
      if (!body?.target) return bad(res, 400, 'target 必填');
      // F51: transport 枚举早期校验(此前 'quantum' 可注册,exec 才报未接入)
      const KNOWN_TRANSPORTS = ['local', 'ssh', 'web'];
      if (!KNOWN_TRANSPORTS.includes(String(body.transport || ''))) {
        return bad(res, 400, `transport 必须是 ${KNOWN_TRANSPORTS.join('/')} 之一`);
      }
      const sh = caps.shells.register({
        name: String(body.name || ''), target: String(body.target),
        // CS23-N16: 缺省与工具面(tools.mjs 'web')对齐——agent 自注册
        // 场景无本地沙箱语义; 显式传 'local' 不受影响。
        transport: String(body.transport || 'web'), transportRef: String(body.transportRef || ''),
        note: String(body.note || ''), tags: Array.isArray(body.tags) ? body.tags : [],
        createdBy: String(body.createdBy || 'operator'),
        ttlHours: Number(body.ttlHours) || 24,
      });
      return json(res, sh.error ? 400 : 200, sh);
    }
    if (path.startsWith('/api/shells/') && path.endsWith('/exec') && method === 'POST') {
      const id = path.split('/')[3];
      const body = await readJson(req);
      if (!body?.command) return bad(res, 400, 'command 必填');
      // F63: 不存在的 shell 此前返回 200+ok:false——与 /sessions/{id}
      // 的 404 语义不一致(接口实测)。统一 404。
      if (!caps.shells.get(id)) return bad(res, 404, 'shell 不存在');
      const r = await caps.shells.exec(id, String(body.command), { timeoutMs: Math.min(Number(body.timeoutMs) || 30000, 120000) });
      return json(res, 200, r);
    }
    if (path.startsWith('/api/shells/') && path.endsWith('/close') && method === 'POST') {
      const id = path.split('/')[3];
      return json(res, 200, caps.shells.close(id));
    }

    // ---------- spawn policy settings (console-editable) ----------
    if (path === '/api/settings' && method === 'GET') {
      return json(res, 200, getSpawnSettings());
    }
    if (path === '/api/settings' && method === 'PUT') {
      const body = await readJson(req);
      // F63: 越界/非数值此前被静默回落默认值并返回 200——调用方
      // 无从得知设置没生效(接口实测)。显式 400。
      for (const k of ['spawnMaxDepth', 'spawnMaxAgents']) {
        if (body[k] === undefined) continue;
        const n = Number(body[k]);
        const max = k === 'spawnMaxDepth' ? 10 : 64;
        if (!Number.isFinite(n) || n < 1 || n > max) {
          return bad(res, 400, `${k} 必须是 [1, ${max}] 内的数字`);
        }
      }
      return json(res, 200, setSpawnSettings(body, wal));
    }

    // ---------- health & registry ----------
    if (path === '/api/health') {
      return json(res, 200, {
        ok: true,
        // CS18-F4: model 字段已删(R32D44 顶栏去模型字样后全仓零消费;
        // 模型多态下单一模型名不再代表平台, 配置见设置页)。
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
      // F6 修复: 服务端 workSessionId 过滤——全量 578 会话 220KB 被 4s 轮询
      // 无界放大;缺省参数保持全量(向后兼容既有调用方)。
      const wsFilter = url.searchParams.get('workSessionId');
      const list = wsFilter
        ? store.list().filter(s => s.workSessionId === wsFilter)
        : store.list();
      return json(res, 200, list);
    }
    // Tree-only projection: the dispatch panel polls every 4s and only
    // needs topology/state fields — 41KB full list → ~6KB per poll.
    if (path === '/api/sessions/tree' && method === 'GET') {
      // R32D32-R6: ?q= 服务端过滤(标题 rawTitle/截断值/ID 不区分大小
      // 写包含)——控制台全局搜索此前每次击键全量拉树, 会话数大时是
      // 全量下载。q 缺省行为不变(全量)。
      const qRaw = new URL(req.url, 'http://x').searchParams.get('q');
      const q = qRaw ? qRaw.trim().toLowerCase() : '';
      return json(res, 200, store.list()
        .filter(s => !q
          || (s.rawTitle ?? '').toLowerCase().includes(q)
          || (s.title ?? '').toLowerCase().includes(q)
          || s.id.toLowerCase().includes(q)
          || s.agentKey.toLowerCase().includes(q))  // R32D35-E2
        .map(s => ({
        id: s.id, agentKey: s.agentKey, title: s.title,
        rawTitle: s.rawTitle ?? null,  // R32D31-E1: 搜索面用未截断值
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
      // R12-1(十二轮): requireFields 失败时已发送 400, 再 bad() 双发
      // headers → ERR_HTTP_HEADERS_SENT 裸栈(缺 agentKey 即触发); 对齐
      // 本文件"requireFields 后先查 headersSent 再 return"的既有模式。
      if (!requireFields(res, body, ['agentKey']) || !isAgentKey(body.agentKey)) {
        if (res.headersSent) return;
        return bad(res, 400, '未知 agentKey(14 键之一)');
      }
      // Engagement metadata marks AutoPwn children — internal only, a
      // console user must not forge orchestrator-linked sessions. The
      // workSessionId grouping key is ordinary user state.
      const opts = {};
      if (body.engagementId && isInternalCaller(req)) {
        opts.engagementId = String(body.engagementId);
        opts.orchestratorSessionId = body.orchestratorSessionId
          ? String(body.orchestratorSessionId) : null;
      }
      if (body.workSessionId) {
        // charset guard: an unchecked id once became a cwd/fs root via
        // path.join(HOST.workspace, '../../…') and persisted in the WAL
        // F13: 长度上限——100KB 全 A 实测被接受,永久入 WAL 放大全量响应
        if (!/^[\w-]+$/.test(String(body.workSessionId))
            || String(body.workSessionId).length > 64) {
          return bad(res, 400, 'workSessionId 仅允许 [a-zA-Z0-9_-]{1,64}');
        }
        opts.workSessionId = String(body.workSessionId).slice(0, 64);
        // auto-register unknown project ids (sessions may arrive before
        // the console ever created the project)
        // R9-F5: 已删项目(墓碑)不复活——会话照建(F58 保留历史),
        // 但项目不再以'未命名'重回列表。
        if (!isTombstoned(opts.workSessionId)) {
          ensureProject(opts.workSessionId, wal);
        }
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
        return bad(res, 404, '会话不存在');
      }

      if (!action && method === 'GET') {
        return json(res, 200, store.summary(record));
      }
      if (action === '/events' && method === 'GET') {
        const since = Number(url.searchParams.get('since') || 0);
        return store.attach(record, sse(req, res), since);
      }
      if (action === '/followup' && method === 'POST') {
        if (!isInternalCaller(req)) {
          return bad(res, 401, '仅限内部调用');
        }
        const body = await readJson(req);
        // R32D31-N2: 非字符串 text 此前 String() 落库 '[object Object]'
        // 永久污染会话与一次性标题——直接 400。
        if (typeof body.text !== 'string' || !body.text.trim()) {
          return bad(res, 400, 'text 必填(非空字符串)');
        }
        const text = body.text.slice(0, CONFIG.maxPromptChars);
        store.followUp(record, text);
        return json(res, 202, { ok: true });
      }
      if ((action === '/messages' || action === '/steer') && method === 'POST') {
        const body = await readJson(req);
        // R32D31-N2: 非字符串 text 此前 String() 落库 '[object Object]'
        // 永久污染会话与一次性标题——直接 400。
        if (typeof body.text !== 'string' || !body.text.trim()) {
          return bad(res, 400, 'text 必填(非空字符串)');
        }
        const text = body.text.slice(0, CONFIG.maxPromptChars);
        // Agent-impersonating injections (Temporal activities) need the
        // internal token; plain console users ride their own session auth.
        if (body.source === 'agent' && !isInternalCaller(req)) {
          return bad(res, 401, 'source=agent 需要内部令牌');
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
        if (!isInternalCaller(req)) {
          return bad(res, 401, '仅限内部调用');
        }
        return json(res, 200, await store.waitIdle(record));
      }
      if (action === '/report-state' && method === 'GET') {
        if (!isInternalCaller(req)) {
          return bad(res, 401, '仅限内部调用');
        }
        // Workflow-side task-report gate reads this (agentTaskWorkflow).
        return json(res, 200, {
          count: record.taskReportCount,
          author: store.authorOf(record),
          lastReport: record.lastReport,
        });
      }
      if (action === '/mark-report-synthesized' && method === 'POST') {
        if (!isInternalCaller(req)) {
          return bad(res, 401, '仅限内部调用');
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
      // R32D31-N1: 此前无条件 setPrefs(currentWs)——API/CLI 建项目会
      // 静默劫持控制台活跃项目(全局单租户偏好), 后续 UI 消息被错分
      // 组。改为显式 opt-in: 仅 body.activate=true 才切换(console 的
      // 内联新建传它保持原体验; curl 集成不再带副作用)。
      if (body.activate === true) setPrefs({ currentWs: created.id }, wal);
      return json(res, 201, created);
    }
    const projMatch = path.match(PROJECT_ID);
    if (projMatch && method === 'PUT') {
      const pid = projMatch[1];
      const body = await readJson(req);
      const p = getProject(pid);
      if (!p) return bad(res, 404, '项目不存在');
      if (body.label !== undefined) renameProject(pid, body.label, wal);
      if (body.agentKey && body.sessionId) {
        setLastSession(pid, body.agentKey, body.sessionId, wal);
      }
      return json(res, 200, getProject(pid));
    }
    const projDelMatch = path.match(PROJECT_ID);
    if (projDelMatch && method === 'DELETE') {
      // F58: projects were immortal — no delete API, no UI entry; test
      // and abandoned projects accumulated forever.
      const pid = projDelMatch[1];
      if (!deleteProject(pid, wal)) return bad(res, 404, '项目不存在');
      return json(res, 200, { deleted: true, id: pid });
    }
    if (path === '/api/prefs' && method === 'GET') {
      return json(res, 200, getPrefs());
    }

    // ---------- agent settings (user-facing config bar) ----------
    // 保存协议: 大多数字段逐字段(带探测/范围校验); LLM 连通两类
    // (common.llm 默认供应商/agent-llm 覆盖)为四字段原子提交。
    if (path === '/api/agent-settings' && method === 'GET') {
      return json(res, 200, getSettings());
    }
    if (path === '/api/agent-settings/save' && method === 'POST') {
      const body = await readJson(req);
      const r = await saveSetting(body, wal);
      if (!r.ok) return bad(res, 400, r.error);
      if (String(body.group) === 'common' || String(body.group) === 'agent-llm') {
        // hot-apply LLM prefs (same process as the session store).
        // R32D44: agent-llm 组也热更——覆盖保存后 live model 的
        // baseUrl/model/api 不刷新, 请求打向默认 OpenAI 端点(实测抓出)。
        await applyLlmPrefs();
      }
      if (String(body.group) === 'recon-source') {
        // CS3-#10: 凭据→注入文件同步抽离 src/keyfiles.mjs(路由层职责)
        await syncSourceKeyFiles();
      }
      return json(res, 200, r);
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
      if (!file) return bad(res, 400, 'file 字段必填(multipart)');
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
        driverIsDocker: cfg.driver === 'docker'  // F4(十五轮): 字段名与语义对齐——此前叫 dockerAvailable 但只反映 driver 选择, Docker 在位+local driver 时误导排障,
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
      await applyMcpAndMounts();
      return json(res, 200, { ...cfg, ensured });
    }
    if (path === '/api/sandbox/cli' && method === 'POST') {
      const body = await readJson(req);
      const cmd = String(body.command || '').trim();
      if (!cmd) return bad(res, 400, 'command 必填');
      const result = await installCli(cmd);
      return json(res, 200, result);
    }
    if (path === '/api/sandbox/tools' && method === 'GET') {
      return json(res, 200, await listInstalledTools());
    }
    // skills CRUD + per-agent mounts
    if (path === '/api/sandbox/skills/rebuild' && method === 'POST') {
      // P1-B(五审): skills-seed 播种后挂载缓存不刷新——"新会话生效"
      // 承诺此前为假(需重启或碰巧触发技能 CRUD)。
      const r2 = await applyMcpAndMounts();
      store.rebuildSessionAgents();
      return json(res, 200, r2);
    }
    if (path === '/api/sandbox/skills' && method === 'GET') {
      return json(res, 200, await listSkillsTree(AGENT_KEYS));
    }
    // R32D44-feature: 技能正文读取(agent 配置面板点开技能看内容)。
    // 校验与 skills CRUD 同款(agentKey 白名单 + name 纯标识符)。
    if (path === '/api/sandbox/skills/content' && method === 'GET') {
      const agentKey = url.searchParams.get('agentKey');
      const name = url.searchParams.get('name');
      if (!agentKey || !name) return bad(res, 400, 'agentKey、name 必填');
      if (!isAgentKey(agentKey) || !/^[\w-]+$/.test(name)) {
        return bad(res, 400, 'agentKey 或 name 非法(name: [a-zA-Z0-9_-]+)');
      }
      const content = await readSkillContent(agentKey, name);
      if (content === null) return bad(res, 404, '技能不存在');
      return json(res, 200, { agentKey, name, content });
    }
    if (path === '/api/sandbox/skills' && method === 'POST') {
      const body = await readJson(req);
      if (!body.agentKey || !body.name || !body.content) {
        return bad(res, 400, 'agentKey、name、content 必填');
      }
      // traversal guard: agentKey must be a real agent, name a plain
      // identifier — a crafted name once reached rm -rf on arbitrary
      // host paths via saveSkill/deleteSkill string concatenation
      if (!isAgentKey(body.agentKey) || !/^[\w-]+$/.test(String(body.name))) {
        return bad(res, 400, 'agentKey 或 name 非法(name: [a-zA-Z0-9_-]+)');
      }
      const filePath = await saveSkill(body.agentKey, {
        name: String(body.name).slice(0, 60),
        description: String(body.description ?? '').slice(0, 200),
        content: String(body.content).slice(0, 50000),
      });
      await applyMcpAndMounts();
      return json(res, 201, { filePath });
    }
    if (path === '/api/sandbox/skills' && method === 'DELETE') {
      const agentKey = url.searchParams.get('agentKey');
      const name = url.searchParams.get('name');
      if (!agentKey || !name) return bad(res, 400, 'agentKey、name 必填');
      if (!isAgentKey(agentKey) || !/^[\w-]+$/.test(name)) {
        return bad(res, 400, 'agentKey 或 name 非法');
      }
      await deleteSkill(agentKey, name);
      await applyMcpAndMounts();
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
      if (!body.name) {
        return bad(res, 400, 'name 必填');
      }
      // R5-F3: 归一化+形状校验(与 tooling.mjs configure_mcp 对齐)——
      // 此前任意 transport 字符串/字符串 command 被持久化, 每轮
      // rebuildMounts spawn 垃圾 argv 且无法自愈。
      const transport = String(body.transport ?? '').trim().toLowerCase();
      if (transport !== 'http' && transport !== 'stdio') {
        return bad(res, 400, 'transport 必须是 http/stdio 之一');
      }
      if (transport === 'stdio'
          && (!Array.isArray(body.command) || body.command.length === 0
              || !body.command.every(x => typeof x === 'string'))) {
        return bad(res, 400, 'stdio command 必须为非空字符串数组, 如 ["npx","-y","server"]');
      }
      if (transport === 'http' && !body.url) {
        return bad(res, 400, 'http transport 需要 url');
      }
      // R22-F3: tooling 侧前置拒绝的镜像——where=sandbox 的 stdio
      // 在 local driver 下永远 spawn 失败, 持久化即永久死挂载。
      if (transport === 'stdio' && body.where === 'sandbox'
          && sandboxConfig().driver !== 'docker') {
        return bad(res, 400, 'where=sandbox 需要 docker driver(当前 local)——请改 where=host');
      }
      const entry = {
        name: String(body.name).slice(0, 60),
        transport,
        agents: Array.isArray(body.agents) ? body.agents.filter(isAgentKey) : [],
        enabled: body.enabled !== false,
        ...(transport === 'http'
          ? { url: String(body.url).slice(0, 500),
              headers: body.headers ?? {} }
          : { command: body.command, env: body.env ?? {},
              where: body.where === 'sandbox' ? 'sandbox' : 'host' }),
      };
      // R5-F2: 同名更新必须失效旧连接——POST 此前从不关闭, 新
      // command/env 永不生效, 旧 stdio 子进程滞留到重启(与 DELETE
      // 路径'removed or CHANGED 都不得存活'的注释矛盾)。
      // R5-F2(连接失效先行)+R22-F2(互斥读改写)语义在 applyMcpAndMounts 固化
      const next = await applyMcpAndMounts({
        closeName: entry.name, closeFirst: true,
        mutate: list => [...list.filter(s => s.name !== entry.name), entry],
      });
      return json(res, 201, next.find(s => s.name === entry.name));
    }
    if (path === '/api/sandbox/mcp' && method === 'DELETE') {
      const name = url.searchParams.get('name');
      if (!name) return bad(res, 400, 'name 必填');  // CS2-#8: 缺参此前静默假成功
      await applyMcpAndMounts({
        closeName: name,
        mutate: list => list.filter(s => s.name !== name),
      });
      return json(res, 200, { deleted: true });
    }
    if (path === '/api/sandbox/cli/installed' && method === 'GET') {
      return json(res, 200, await sharedLayerTools());
    }
    if (path === '/api/sandbox/cli' && method === 'DELETE') {
      const name = url.searchParams.get('name');
      if (!name) return bad(res, 400, 'name 必填');
      const r = await uninstallCliTool(name);
      return json(res, 200, r);
    }
    if (path === '/api/sandbox/mcp/test' && method === 'POST') {
      const body = await readJson(req);
      const server = (await loadMcpConfig())
        .find(s => s.name === body.name);
      if (!server) return bad(res, 404, 'MCP 服务器不存在');
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
      // R32D32-R6: ?q= 服务端过滤(title/summary 包含, 不区分大小写)——
      // 全局搜索此前全量拉总线再前端滤。
      const qRaw = url.searchParams.get('q');
      const q = qRaw ? qRaw.trim().toLowerCase() : '';
      const events = bus.list(since);
      return json(res, 200, ws
        ? events.filter(e => e.workSessionId === ws
          && (!q
            || `${e.title ?? ''}`.toLowerCase().includes(q)
            || `${e.summary ?? ''}`.toLowerCase().includes(q)))
        : (q
          ? events.filter(e =>
            `${e.title ?? ''}`.toLowerCase().includes(q)
            || `${e.summary ?? ''}`.toLowerCase().includes(q))
          : events));
    }
    if (path === '/api/bus/events' && method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      return bus.attach(sse(req, res), since);
    }
    if (path === '/api/bus' && method === 'POST') {
      if (!isInternalCaller(req)) {
        return bad(res, 401, '仅限内部调用');
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
        return bad(res, 404, '总线条目不存在');
      }
      const fields = {};
      for (const k of ['title', 'severity', 'status', 'text']) {
        // R27-F4: 显式 null 归一为未提供——status=null 此前落库并把
        // summary 拼成 'null · x'(R2-F3 同类 null 语义分裂)
        if (body[k] !== undefined && body[k] !== null) fields[k] = body[k];
      }
      if (!Object.keys(fields).length) {
        return bad(res, 400, '无可修订字段');
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
        return bad(res, 400, 'instruction 必填');
      }
      const target = bus.list().find(e => e.seq === Number(body.seq) && !e.revises);
      if (!target) {
        return bad(res, 404, '总线条目不存在');
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
      // F17: 只允许可派发键——report 是服务 agent(writer 唤醒制),config 三兄弟非 stage
      const agents = (body.agents || []).filter(k => SPAWNABLE_KEYS.includes(k));  // CS3-N22: 与 resume 同语义过滤
      if (!instruction || agents.length === 0) {
        return bad(res, 400, 'instruction 与 agents 必填(仅可派生 agent)');
      }
      // F54: 外部启动的 engagement 此前不携带 workSessionId →
      // orchestrator 及全部子会话/share/task-report 事件 ws=None,
      // 在任何项目面板都不可见(全链"蒸发")。接受可选 ws 并透传。
      const wsParam = String(body.workSessionId || '').slice(0, 64);
      if (wsParam && !/^[\w-]+$/.test(wsParam)) {
        return bad(res, 400, 'workSessionId 仅允许 [a-zA-Z0-9_-]{1,64}');
      }
      const started = await startAutopwn({
        engagementId: undefined, instruction, agents,
        workSessionId: wsParam || undefined,
      });
      return json(res, 201, started);
    }
    // ---------- autopwn resume(断点续跑——只补跑未完成的 agent) ----------
    if (path === '/api/autopwn/resume' && method === 'POST') {
      const body = await readJson(req);
      const prevId = String(body.engagementId || '');
      const instruction = String(body.instruction || '').slice(0, 8000);
      if (!prevId || !instruction) {
        return bad(res, 400, 'engagementId 与 instruction 必填');
      }
      const prevEngagement = `autopwn-${prevId}`;
      // F1 修复:存在性校验——bus 有事件 OR Temporal describe 成功(双通道:
      // temporal-dev 历史保留期短于 bus WAL,老战役工作流记录过期仍可续跑)。
      // 两者皆无 = typo/不存在的 ID,404 引导走主端点,防静默全量新战役。
      const knownByBus = bus.list().some(e => e.engagement === prevEngagement);
      if (!knownByBus) {
        try {
          await describeWorkflow(prevEngagement);
        } catch {
          return bad(res, 404, 'engagement 不存在, 请先 POST /api/autopwn');
        }
      }
      // 从 bus 提取旧战役的完成信号: result/share 事件按 agent 归类
      const completed = new Set();
      for (const ev of bus.list()) {
        if (ev.engagement !== prevEngagement) continue;
        const from = ev.from || '';
        if (STAGE_KEYS.includes(from)  // CS2-#21 单源
            && (ev.channel === 'share' || (ev.channel === 'dm' && ev.type === 'result'))) {
          completed.add(from);
        }
      }
      const requested = (body.agents || []).filter(isAgentKey);
      const pool = requested.length > 0 ? requested.filter(k => SPAWNABLE_KEYS.includes(k))
        : SPAWNABLE_KEYS;
      const rerun = pool.filter(k => !completed.has(k));
      if (rerun.length === 0) {
        return json(res, 200, { engagementId: prevId, resumed: false,
          completed: [...completed], rerun: [],
          message: '旧战役全部 agent 已有产出,无需续跑' });
      }
      if (body.dryRun) {
        return json(res, 200, { engagementId: prevId, dryRun: true,
          completed: [...completed], rerun });
      }
      const wsResume = String(body.workSessionId || '').slice(0, 64);
      if (wsResume && !/^[\w-]+$/.test(wsResume)) {
        return bad(res, 400, 'workSessionId 仅允许 [a-zA-Z0-9_-]{1,64}');
      }
      const started = await startAutopwn({ engagementId: undefined, instruction, agents: rerun,
        workSessionId: wsResume || undefined });
      return json(res, 201, { ...started, resumed: true,
        completed: [...completed], rerun,
        message: `续跑:跳过 ${completed.size} 个已完成,重跑 ${rerun.length} 个` });
    }
    if (path === '/api/autopwn' && method === 'GET') {
      const workflowId = url.searchParams.get('workflowId');
      if (!workflowId) {
        return bad(res, 400, 'workflowId 必填');
      }
      try {
        const desc = await describeWorkflow(workflowId);
        return json(res, 200, { ...desc, bus: bus.list().filter(e => e.engagement === workflowId) });
      } catch (err) {
        return bad(res, 404, String(err));
      }
    }

    // ---------- 数据源可用性复查(挂载门:不可用 ⇒ 前端可见+不注入) ----------
    if (path === '/api/agent-settings/verify' && method === 'GET') {
      const keys = getPrefs().reconApiKeys ?? {};
      const results = [];
      for (const [sid, cfg] of Object.entries(keys)) {
        if (sid === 'brute') continue;
        const def = RECON_SOURCES_INTERNAL[sid];
        if (!def || !cfg) continue;
        // R10-F3/CS17-4: 与 save 侧口径统一——hasSourceCredential 单源
        // (含 smtp.user; censys.id 降为参数型字段——R10-F1)。
        if (!hasSourceCredential(cfg, sid)) { results.push({ id: sid, configured: false }); continue; }
        const v = await def.validate(cfg);
        results.push({
          id: sid, configured: true, label: def.label,
          agents: def.agents ?? ['recon'],
          ok: v.ok, error: v.ok ? null : (v.error || '').slice(0, 160),
        });
      }
      return json(res, 200, { results, checkedAt: new Date().toISOString() });
    }

    // ---------- phish campaign 漏斗(GoPhish 面板数据; CS3-#10 抽离
    // src/phish-funnel.mjs) ----------
    if (path === '/api/phish/campaigns' && method === 'GET') {
      return json(res, 200, phishCampaignFunnel());
    }

    return bad(res, 404, '资源不存在');
  };
  return route;
}
