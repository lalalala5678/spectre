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
import fs from 'node:fs';
import { describeWorkflow, startAutopwn } from './temporal.mjs';
import { getSpawnSettings, setSpawnSettings } from './settings.mjs';
import { SESSION_NAME_MAX, SESSION_DESC_MAX, injectionOriginOf, dmNextSeq } from './sessions.mjs';
import { emitRevision } from './revision.mjs';
import { sandboxConfig, saveSandboxConfig, ensureSandbox, installCli, listInstalledTools, sharedLayerTools, uninstallCliTool } from './sandbox/container.mjs';
import { listProjects, getProject, ensureProject, renameProject, createProject, setLastSession, getPrefs, setPrefs, deleteProject, isTombstoned } from './projects.mjs';
import { saveSkill, deleteSkill, listSkillsTree, readSkillContent } from './sandbox/skills.mjs';
import { applyMcpAndMounts } from './sandbox/apply-config.mjs';
import { syncSourceKeyFiles } from './keyfiles.mjs';
import { phishCampaignFunnel } from './phish-funnel.mjs';
import { loadMcpConfig, testMcpServer } from './sandbox/mcp.mjs';
import { maskSecret, isSecretLeaf, getSettings, saveSetting, hasSourceCredential, revealSetting, RECON_SOURCES_INTERNAL } from './agent-settings.mjs';
import { applyLlmPrefs } from './pi.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { HOST } from './sandbox/exec-env.mjs';

const SESSION_ID = /^\/api\/sessions\/([a-z0-9-]+)(\/[a-z-]+)?$/;
const PROJECT_ID = /^\/api\/projects\/([\w-]{1,64})$/;  // CS3-N22: 单源; CS47-N6: 与 workSessionId/currentWs 同 id 域

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

// CS44-R32D67-B/CS66-F4: prefs 凭据掩码视图(GET/PUT 回显共用; 掩码
// 哨兵写面在 agent-settings save 路径, 本端点只读)。CS67-1: 真提层(DD 仅改缩进仍嵌 realRouter 内, AST 实证)。
function maskPrefs(raw) {
  return {
    ...raw,
    commonSettings: raw.commonSettings ? {
      ...raw.commonSettings,
      llm: raw.commonSettings.llm ? { ...raw.commonSettings.llm,
        apiKey: raw.commonSettings.llm.apiKey ? maskSecret(raw.commonSettings.llm.apiKey) : raw.commonSettings.llm.apiKey } : raw.commonSettings.llm,
      webSearch: raw.commonSettings.webSearch ? { ...raw.commonSettings.webSearch,
        apiKey: raw.commonSettings.webSearch.apiKey ? maskSecret(raw.commonSettings.webSearch.apiKey) : raw.commonSettings.webSearch.apiKey } : raw.commonSettings.webSearch,
    } : raw.commonSettings,
    agentLlm: Object.fromEntries(Object.entries(raw.agentLlm ?? {}).map(([k, v]) =>
      [k, v?.apiKey ? { ...v, apiKey: maskSecret(v.apiKey) } : v])),
    reconApiKeys: Object.fromEntries(Object.entries(raw.reconApiKeys ?? {}).map(([src, o]) =>
      [src, Object.fromEntries(Object.entries(o ?? {}).map(([fk, fv]) =>
        [fk, isSecretLeaf(src, fk) ? maskSecret(fv) : fv]))])),
  };
}

function realRouter({ store, bus, caps, wal }) {
  /** 自测r2-#3: engagement 子会话看门狗——30min 无 journal 事件 nudge,
   * 60min 终止+DM 通报编排者(与 agent-runtime spawnChild 同语义)。 */
  function attachEngagementWatchdog(child, _wal) {
    const NUDGE_MS = 30 * 60_000, KILL_MS = 60 * 60_000;
    setInterval(() => {
      const rec = store.get(child.id);
      const last = rec?.events?.[rec.events.length - 1];
      const idleMs = last ? Date.now() - Date.parse(last.ts) : 0;
      if (!rec || !rec.busy) return;
      if (idleMs >= KILL_MS) {
        rec.busy = false;
        store._journal(rec, 'watchdog_kill', { idleMs });
        bus.emit({ channel: 'dm', from: 'system', to: 'autopwn', type: 'watchdog',
          summary: `看门狗: engagement 子任务 ${child.id.slice(0, 16)}… 60 分钟无事件已终止。` });
      } else if (idleMs >= NUDGE_MS && !rec._wdNudged) {
        rec._wdNudged = true;
        store.followUp(rec, '【看门狗】30 分钟无事件——请汇报当前状态与阻塞点; 已无法推进请立即提交任务报告收尾。');
      }
    }, 60_000).unref?.();
  }

  const route = async function route(req, res, url) {
    const path = url.pathname;
    const method = req.method;

    // ---------- shells (C2 implant handles: list/register/exec/close) ----------
    if (path === '/api/shells' && method === 'GET') {
      // r50: 控制台按项目过滤(url.workspaceId?); 无参=全量(兼容)
      const qs = new URL(req.url, 'http://x').searchParams;
      const wsf = qs.get('workSessionId');
      const all1 = caps.shells.list();
      return json(res, 200, { shells: wsf ? all1.filter(s => s.workSessionId === wsf) : all1 });
    }
    if (path === '/api/shells' && method === 'POST') {
      const body = await readJson(req);
      // R32D84-N1: 必填/格式要求一次性列全(此前逐字段逐轮揭示——
      // target→name→transportRef 三轮才见全貌)。
      if (!body?.target) {
        return bad(res, 400, 'target 必填; 通道必填面: target+name(建议 目标-面-权限)+transportRef(web 含 {CMD}/ssh user:pass@host[:port]/local 容器名[:用户]); 可选: transport(local/ssh/web 缺省 web), note, tags, ttlHours');
      }
      // F51/CS24-F4: 枚举早期校验(此前 'quantum' 可注册,exec 才报未接入)。
      // 缺省统一 'web'(CS23-N16, 与 tools.mjs 工具面一致——agent 自注册
      // 无本地沙箱语义)——先归一再校验, 此前 || 'web' 在守卫后不可达。
      const KNOWN_TRANSPORTS = ['local', 'ssh', 'web'];
      const transport = String(body.transport || 'web').toLowerCase();  // CS27-14: 与 agent 入口同归一('WEB'→'web' 不再 400)
      if (!KNOWN_TRANSPORTS.includes(transport)) {
        return bad(res, 400, `transport 必须是 ${KNOWN_TRANSPORTS.join('/')} 之一`);
      }
      const sh = caps.shells.register({
        name: String(body.name || ''), target: String(body.target),
        transport, transportRef: String(body.transportRef || ''),
        note: String(body.note || ''), tags: Array.isArray(body.tags) ? body.tags : [],
        createdBy: String(body.createdBy || 'operator'),
        ttlHours: Number(body.ttlHours) || 24,
        meta: { workSessionId: body.workSessionId ?? null },
      });
      return json(res, sh.error ? 400 : 200, sh);
    }
    if (path.startsWith('/api/shells/') && path.endsWith('/read-file') && method === 'POST') {
      const id = path.split('/')[3];
      const b3 = await readJson(req);
      if (!b3.path) return bad(res, 400, 'path 必填');
      const r3 = await caps.shells.readFile(id, String(b3.path));
      return json(res, r3?.error ? 400 : 200, r3 ?? { error: 'shell 不存在' });
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
      // CS41-B5: 与 exec 同 404 语义(F63 只修了 exec——close 此前 200+ok:false)。
      if (!caps.shells.get(id)) return bad(res, 404, 'shell 不存在');
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
    // r6v2-#10: engagement 成员终报对账面——完成通知/状态判定用情报库
    // 作事实源(ChildWorkflowFailure 可能与已落账终报并存, 直接报失败
    // 即假警报)。内部调用。
    if (path.startsWith('/api/engagements/') && path.endsWith('/children') && method === 'GET') {
      if (!isInternalCaller(req)) return bad(res, 401, '仅限内部调用');
      const engId = path.split('/')[3];
      // r42-F-J: 前缀归一——bus 事件 engagement 带 'autopwn-' 前缀
      // (workflows L86), 通知 recheck 传裸 id, 精确匹配曾永不命中
      // (6016/6027 落账早于快照仍被称"无终报")。双向归一后 join 同源
      // 同谓词。
      const engIds = new Set([engId, `autopwn-${engId}`,
        engId.replace(/^autopwn-/, '')]);
      const out = {};
      for (const e of bus.list()) {
        if (!engIds.has(e.engagement) || e.type !== 'task-report') continue;
        const key = e.from;
        if (!out[key] || e.seq > out[key].seq) {
          out[key] = { seq: e.seq, status: e.status, title: e.title };
        }
      }
      // r35-D7b: 重派/补位席位的终报带的是其原会话的 engagement(实测
      // 5557: engagement=旧战役 id), 精确匹配曾把已落账终报判"库内无
      // 终报"(假警报最后一环)。未命中的席位 key 补按 agentKey 的最新
      // task-report(标 crossEngagement——recheck 语义是"该席位完成没",
      // 不是"这场战役的字面归属")。
      const seen = new Set(Object.keys(out));
      const members = new Set();
      for (const e of bus.list()) {
        if (engIds.has(e.engagement) && e.type === 'dispatch') {
          for (const k of e.to ?? []) members.add(k);
        }
      }
      for (const e of [...bus.list()].reverse()) {
        if (e.type !== 'task-report' || !members.has(e.from) || seen.has(e.from)) continue;
        out[e.from] = { seq: e.seq, status: e.status, title: e.title,
          crossEngagement: e.engagement ?? null };
        seen.add(e.from);
      }
      return json(res, 200, out);
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
        opts.name = String(body.name).slice(0, SESSION_NAME_MAX);  // CS41-B4: 单源
      }
      if (body.description) {
        opts.description = String(body.description).slice(0, SESSION_DESC_MAX);  // CS41-B4: 单源
      }
      const record = store.create(body.agentKey, opts);
      // 自测r2-#3: engagement 子会话同挂看门狗(此前仅 spawn 本地路径有
      // ——engagement 4 代理越 30 分钟阈值无 nudge 的实测缺口)。
      if (opts.orchestratorSessionId) attachEngagementWatchdog(record, wal);
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
        // 自测r3-#8 真接线: engagement DM 实走 /followup(此前仅
        // /messages+/steer 包序号——两轮宣称两轮不可见的根因)。
        const raw = String(body.text).slice(0, CONFIG.maxPromptChars);
        const tagged = /^\[DM #\d+ from /.test(raw)
          ? raw
          : `[DM #${dmNextSeq(record.id)} from ${String(body.from ?? 'system')}] ${raw}`;
        store.followUp(record, tagged);
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
        let r14pending = false;  // r14-③(作用域提升——try 内声明曾致 catch 外引用炸, degradedNote 同型)
        try {
          // body.source==='agent' marks Temporal-side injections (internal
          // token enforced above); classify their origin so the console
          // never renders them as the human user.
          // 自测r2-#8: agent 注入统一带投递序号(与 sessions 本地 DM
          // 同一序号器; [DM from X] → [DM #n from X])。
          let injectText = text;
          if (body.source === 'agent') {
            injectText = /^\[DM #\d+ from /.test(injectText)
              ? injectText
              : injectText.replace(/^\[DM from ([^\]]+)\]/,
                  (_, who) => `[DM #${dmNextSeq(record.id)} from ${who}]`);
            // 任务注入(非 DM 文本)带投递序号头(自测r3 第 5 观测点)
            if (!injectText.startsWith('[DM #')) {
              injectText = `[DM #${dmNextSeq(record.id)} from system] ${injectText}`;
            }
          }
          const source = body.source === 'agent'
            ? injectionOriginOf(injectText) : undefined;
          if (action === '/messages') {
            store.prompt(record, injectText, source);
          } else {
            store.steer(record, injectText, source);
          }
          // r14-③: steer 回执附未决提醒——目标代理尚未提交任务报告时
          // 明示(编排器可判断该代理仍在途)。
          r14pending = action === '/steer' && (record.taskReportCount ?? 0) === 0;
        } catch (err) {
          return bad(res, err.statusCode || 500, err.message);
        }
        return json(res, 202, { ok: true, ...(r14pending ? { pendingReport: true, hint: '该代理尚未提交任务报告(在途)' } : {}) });
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
      // entries (keeps ids so existing sessions stay grouped; CS47-N6:
      // 同 id 域校验, skipped/existed 明细分因随响应披露)
      if (Array.isArray(body.projects)) {
        // CS47-N6: 迁移注册同 id 域校验(此前 verbatim)。R32D72-N2:
        // 明细分因 skipped(域外/缺 id)与 existed(已存在幂等跳过)。
        const skipped = [];
        const existed = [];
        for (const p of body.projects) {
          const idOk = p?.id != null && typeof p.id === 'string' && /^[\w-]{1,64}$/.test(p.id);
          if (!idOk) { skipped.push(p?.id == null ? '(missing id)' : String(p.id)); continue; }
          if (getProject(p.id)) { existed.push(String(p.id)); continue; }
          ensureProject(p.id, wal, String(p.label ?? '').slice(0, 60));
        }
        // CS49-F6: 响应形状恒定(机器消费免 Array.isArray 分叉)。
        const projects = listProjects();
        const parts = [];
        if (skipped.length) parts.push(`域外/缺 id 未注册: ${skipped.join(', ')}`);
        if (existed.length) parts.push(`已存在跳过: ${existed.join(', ')}`);
        return json(res, 201, parts.length ? { projects, skipped, existed, note: parts.join('; ') } : { projects });
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

    // ── 渗透授权面(r47): scope 前端可配置 + agent 授权请求一键批驳 ──
    const scopePath = path_mod.join(CONFIG.dataDir, 'tools/c2/scope.json');
    const readScope = () => {
      try { return JSON.parse(fs.readFileSync(scopePath, 'utf8')); } catch { return null; }
    };
    const writeScope = (sc) => {
      fs.mkdirSync(path_mod.dirname(scopePath), { recursive: true });
      fs.writeFileSync(scopePath, JSON.stringify(sc, null, 2) + '\n');
    };
    if (path === '/api/scope' && method === 'GET') {
      return json(res, 200, readScope() ?? { targets: [], exercise: '', window: null });
    }
    if (path === '/api/scope' && method === 'PUT') {
      const b = await readJson(req);
      const targets = Array.isArray(b.targets) ? [...new Set(b.targets.map(String).filter(t => t.trim()))] : null;
      if (!targets) return bad(res, 400, 'targets 须为字符串数组');
      const sc = readScope() ?? { targets: [], exercise: '', window: {} };
      sc.targets = targets;
      if (typeof b.exercise === 'string') sc.exercise = b.exercise;
      if (b.window && typeof b.window.start === 'string' && typeof b.window.end === 'string') {
        sc.window = { start: b.window.start, end: b.window.end };
      }
      writeScope(sc);
      bus.emit({ channel: 'audit', from: 'system', type: 'context',
        title: `渗透授权清单已更新(用户直改): targets=${targets.join('/')}`,
        summary: `窗口:${sc.window?.start ?? '?'}→${sc.window?.end ?? '?'}`, workSessionId: null });
      return json(res, 200, sc);
    }
    if (path === '/api/scope/auth-requests' && method === 'GET') {
      // pending = auth-request 且无后续 approved/rejected 事件 resolves 它
      const evs = bus.list().filter(e => e.type === 'auth-request');
      const settled = new Set(evs.filter(e => e.resolves).map(e => e.resolves));
      // r47b: 白名单修复前的脏事件(target 为空)过滤——24 条历史垃圾
      // pending 隐去(不删链, 审计可考古)。
      const pending = evs.filter(e => !e.resolves && !settled.has(e.seq)
        && e.target)
        .map(e => ({ seq: e.seq, target: e.target, reason: e.reason,
          from: e.from, requester: e.requester, ts: e.ts }));
      return json(res, 200, pending);
    }
    if (path.startsWith('/api/scope/auth-requests/') && (method === 'POST')) {
      // /api/scope/auth-requests/<seq>/approve|reject
      const parts = path.split('/');
      const seq = Number(parts[4]); const act = parts[5];
      const reqEv = bus.list().find(e => e.seq === seq && e.type === 'auth-request' && !e.resolves);
      if (!reqEv) return bad(res, 404, `授权请求 seq=${seq} 不存在或已处理`);
      if (act === 'approve') {
        const b2 = await readJson(req).catch(() => ({}));
        const sc = readScope() ?? { targets: [], exercise: '', window: {} };
        if (!sc.targets.includes(reqEv.target)) {
          sc.targets.push(reqEv.target);
        }
        // r47b: 确认卡带时间期限(默认一周由前端给; 后端兜底 now+7d)
        if (typeof b2.windowStart === 'string' && typeof b2.windowEnd === 'string') {
          sc.window = { start: b2.windowStart, end: b2.windowEnd };
        } else if (!sc.window) {
          sc.window = { start: new Date().toISOString(),
            end: new Date(Date.now() + 7 * 86400e3).toISOString() };
        }
        writeScope(sc);
        bus.emit({ channel: 'audit', from: 'system', type: 'auth-request',
          resolves: seq, status: 'approved', target: reqEv.target,
          title: `授权已批准: ${reqEv.target}`, summary: `用户批准了 ${reqEv.requester ?? reqEv.from} 对 ${reqEv.target} 的授权请求——目标已入清单。`,
          workSessionId: reqEv.workSessionId ?? null });
        caps.followUp?.(reqEv.payloadRef?.replace(/^sess:/, '') ?? reqEv.sessionId,
          `[授权已批准] 你请求的渗透目标 ${reqEv.target} 已被用户加入授权清单——现在可正常对该目标执行(register/exec 等将放行)。`);
        return json(res, 200, { ok: true, targets: sc.targets });
      }
      if (act === 'reject') {
        bus.emit({ channel: 'audit', from: 'system', type: 'auth-request',
          resolves: seq, status: 'rejected', target: reqEv.target,
          title: `授权被驳回: ${reqEv.target}`, summary: `用户驳回了 ${reqEv.requester ?? reqEv.from} 对 ${reqEv.target} 的授权请求。`,
          workSessionId: reqEv.workSessionId ?? null });
        caps.followUp?.(reqEv.payloadRef?.replace(/^sess:/, '') ?? reqEv.sessionId,
          `[授权被驳回] 用户驳回了你对 ${reqEv.target} 的授权请求——请勿再尝试该目标, 调整方案或汇报。`);
        return json(res, 200, { ok: true });
      }
      return bad(res, 400, '未知 action(approve|reject)');
    }
    if (path === '/api/prefs' && method === 'GET') {
      return json(res, 200, maskPrefs(getPrefs()));
    }

    // ---------- agent settings (user-facing config bar) ----------
    // 保存协议: 大多数字段逐字段(带探测/范围校验); LLM 连通两类
    // (common.llm 默认供应商/agent-llm 覆盖)为四字段原子提交。
    if (path === '/api/agent-settings' && method === 'GET') {
      return json(res, 200, getSettings());
    }
    // EQ-U4: 小眼睛明文查看(密码类)——bus 留痕(授权访问审计面)
    if (path === '/api/agent-settings/reveal' && method === 'POST') {
      const body = await readJson(req);
      const kind = String(body?.kind ?? '');
      const id = String(body?.id ?? '');
      const field = String(body?.field ?? '');
      if (!/^[a-zA-Z0-9_.-]{0,64}$/.test(id) || !/^[a-zA-Z0-9_]{1,32}$/.test(field)
        || !['llm-default', 'llm-agent', 'common', 'source'].includes(kind)) {
        return bad(res, 400, '非法 reveal 参数');
      }
      const value = revealSetting(kind, id, field);
      // FEVERIFY11-P1-1: 审计留痕走 bus(可见于审计页+journal 持久)——
      // 此前 wal.append 裸行不进 bus, 审计页零显示且压缩即丢。
      bus.emit({ channel: 'audit', from: 'console', type: 'context',
        summary: `查看密钥明文 ${kind}:${id || '-'}:${field}` });
      return json(res, 200, { value });
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
      // R32D66-NEW1: 凭据/LLM 子树拒绝裸写——契约「LLM 保存必真实连通
      // 探测」只在 /api/agent-settings/save 通道成立(此前经本端点可绕
      // 过探测直落坏配置且不热更)。
      // CS51-2: 对象体守卫前置(标量 JSON "x"/42/true 此前穿透 'in'
      // 检查后 setPrefs 抛 TypeError 500)。
      if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
        return bad(res, 400, '请求体须为 JSON 对象');
      }
      // R32D67-A: 三凭据子树键整体拒(含 null/空对象/异形——此前 truthy
      // 判断使 {commonSettings:{}} 200 且静默清空 llm)。
      if ('commonSettings' in body || 'agentLlm' in body || 'reconApiKeys' in body) {
        return bad(res, 400, '凭据/LLM 配置须经 /api/agent-settings/save(POST, 保存前真实连通探测+热更)——/api/prefs 不接受 commonSettings/agentLlm/reconApiKeys 键');
      }
      // R32D68-NEW-1/CS47-N2: 非凭据键形状校验——ui 须普通对象(字符串
      // 会被 spread 成字符索引键持久化); currentWs 须项目 id 字符串或 null。
      if ('ui' in body && (typeof body.ui !== 'object' || body.ui === null || Array.isArray(body.ui))) {
        return bad(res, 400, 'ui 须为普通对象(键值对)——非对象值会被展开成字符索引');
      }
      // CS46-F1: currentWs 与 workSessionId 同 id 域([\w-]{1,64}——此前
      // ws- 前缀正则误伤 API 建的非前缀项目, console 选中即 400 静默吞)。
      // CS47-N1: 先验原类型再验域——此前 String() 视图过门而 raw 落盘
      // (number/数组原样持久化, 端点自身文案被破)。
      if ('currentWs' in body && !(body.currentWs === null
        || (typeof body.currentWs === 'string' && /^[\w-]+$/.test(body.currentWs)
          && body.currentWs.length <= 64))) {
        return bad(res, 400, 'currentWs 须为项目 id 字符串([a-zA-Z0-9_-]{1,64})或 null');
      }
      // R32D67-B: 回显与 GET 同掩码(此前 200 响应原样回明文 apiKey)。
      // CS48-5: 形状违规统一 400(setPrefs 同步 throw 此前冒泡 500);
      // R32D71: 白名单顶层键(未知键拒——此前任意键原样持久化进 WAL)。
      const PREFS_KEYS = new Set(['ui', 'currentWs']);
      const unknown = Object.keys(body).filter(k => !PREFS_KEYS.has(k));
      if (unknown.length) {
        return bad(res, 400, `未知 prefs 键: ${unknown.join(', ')}(允许: ui/currentWs——凭据/LLM 走 /api/agent-settings)`);
      }
      try {
        return json(res, 200, maskPrefs(setPrefs(body, wal)));
      } catch (e) {
        return bad(res, 400, e instanceof Error ? e.message : String(e));
      }
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
        // CS42-F9: driverIsDocker 字段已删(全仓零消费者——console 侧 C7 已先行)
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
      // R32D68-OBS1: local 驱动=宿主执行——宿主包管理器命令须显式
      // opt-in(与启动 bootstrap 的 SPECTRE_ALLOW_HOST_BOOTSTRAP 同哲学)。
      // CS46-F3: 覆盖面扩至常见宿主包管理器/远程脚本执行器。
      const hostPkg = /\b(apt(?:-get)?|pip3?|pipx|snap|apk|yum|dnf|brew|gem|cargo|conda|uv|npm|npx|curl|wget)\b/.test(cmd);
      if (hostPkg && sandboxConfig().driver !== 'docker'
        && process.env.SPECTRE_ALLOW_HOST_BOOTSTRAP !== '1') {
        return bad(res, 400, 'local 驱动下该命令将变更宿主机——设 SPECTRE_ALLOW_HOST_BOOTSTRAP=1 显式确认(或用 docker 驱动)');
      }
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
      // CS76-6: Temporal 不可达 503 分流(与三处消费点一致, 此前落 500)。
      let started;
      try {
        started = await startAutopwn({
          engagementId: undefined, instruction, agents,
          workSessionId: wsParam || undefined,
        });
      } catch (e) {
        if (e?.temporalUnreachable) return bad(res, 503, e.message);
        throw e;
      }
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
        } catch (e) {
          // CS74-N5: Temporal 不可达≠engagement 不存在——503 指路而非
          // 404 误导(源点 temporalClient 包裹打 temporalUnreachable 标)。
          if (e?.temporalUnreachable) {
            return bad(res, 503, e.message);  // CS75-F2: 源点文案已含指引, 不再嵌套
          }
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
      let started;
      try {
        started = await startAutopwn({ engagementId: undefined, instruction, agents: rerun,
          workSessionId: wsResume || undefined });
      } catch (e) {
        if (e?.temporalUnreachable) return bad(res, 503, e.message);
        throw e;
      }
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
        // CS75-F1: Temporal 不可达≠不存在——503 分流(第三消费点)。
        if (err?.temporalUnreachable) return bad(res, 503, err.message);
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
