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
import { createRouter } from './src/routes.mjs';
import { SessionStore } from './src/sessions.mjs';
import { entryKind as entryKindOf } from './src/tools.mjs';
import { emitRevision } from './src/revision.mjs';
import { buildPi, textOf, applyLlmPrefs } from './src/pi.mjs';
import { shellBusAdapter } from './src/shells.mjs';
import { effectiveCommon, migrateLegacyLlmEnv } from './src/agent-settings.mjs';
import { describeWorkflow, signalEngagement, startAutopwn } from './src/temporal.mjs';
import { Summarizer } from './src/summarizer.mjs';
import { rebuildMounts } from './src/sandbox/mount.mjs';
import { getSpawnSettings, spawnSettingsFromWal } from './src/settings.mjs';
import { makeSpawnPolicy } from './src/spawn-policy.mjs';
import { Wal } from './src/persist.mjs';
import { loadSandboxConfig, ensureSandbox } from './src/sandbox/container.mjs';
import { projectsFromWal, listProjects, getPrefs, tombstonesAll } from './src/projects.mjs';
import { AGENT_KEYS } from './src/agents.mjs';
import path from 'node:path';
import fs, { readFileSync } from 'node:fs';  // CS18-F6: 合并同模块双 import

// N7(部署审计五轮, P0): 数据目录实例锁——boot compaction 原先发生在
// 端口 bind 之前, 多实例共用数据目录时"先原子重写 WAL 再 EADDRINUSE
// 崩溃"(实测静默覆写生产 state.wal)。任何读取/重写前先原子占锁
// ('wx' 独占创建); 持有者已死(PID 不存活)则收尸重取。
// G4(部署审计六轮): 未显式指定数据目录而回落系统缺省路径时显著横幅
// ——该路径常为生产/多实例共用, 本轮审计亲证足枪。
if (!process.env.SPECTRE_DATA_DIR && !process.env.SPECTRE_SANDBOX_ROOT) {
  console.warn('='.repeat(72));
  console.warn(`[runtime] 未设置 SPECTRE_DATA_DIR —— 使用缺省 ${CONFIG.dataDir}`);
  console.warn('[runtime] 多实例/测试部署请显式指定独立目录(如 SPECTRE_DATA_DIR=/tmp/spectre-data)');
  console.warn('='.repeat(72));
}
const lockPath = path.join(CONFIG.dataDir, '.instance.lock');
fs.mkdirSync(CONFIG.dataDir, { recursive: true });
const pidAlive = pid => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const takeLock = () => {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false;
  }
};
if (!takeLock()) {
  let holder = null;
  try { holder = Number(fs.readFileSync(lockPath, 'utf8').trim()); }
  catch { /* 无 holder=陈旧锁, 走下方防误杀 */ }
  if (pidAlive(holder)) {
    console.error(
      `[runtime] FATAL: 数据目录 ${CONFIG.dataDir} 已被实例 PID ${holder} 持有——共用数据目录的第二实例会互相覆写 WAL; 设置 SPECTRE_DATA_DIR 指向独立目录`);
    process.exit(1);
  }
  console.warn(`[runtime] 清理残留锁(持有者 PID ${holder} 已退出)`);
  try { fs.unlinkSync(lockPath); } catch { /* best-effort: 锁文件已不存在 */ }
  if (!takeLock()) {
    console.error(`[runtime] FATAL: 实例锁竞争失败(${lockPath})`);
    process.exit(1);
  }
}
process.on('exit', () => { try { fs.unlinkSync(lockPath); } catch { /* best-effort: 锁文件已不存在 */ } });

const { model, streamFn, modelForAgent } = await buildPi();
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
// R32D44-llm: 旧 .env LLM_* 一次性导入平台配置(此后 env 通道失效)。
// 必须在 WAL replay 之后——此前放在 wal.open 后读到的是模块初值,
// 每次开机都重复迁移(幂等但 WAL 每靴多一条); 且 buildPi 先于本处,
// 导入后立即热更 live model 身份字段(否则首请求打向空 baseUrl)。
const migratedLlm = migrateLegacyLlmEnv(wal);
if (migratedLlm) {
  console.log('[agent-runtime] 已将 .env 的 LLM_* 一次性导入平台配置(以后请在「设置」页管理)');
}
// R32D48-P0: 无条件热更——buildPi(上文)先于 WAL replay 以空 prefs 建
// live model, 迁移后任何重启不再走迁移分支, live model 的 baseUrl 停留
// 构建期空值→OpenAI SDK 默认 api.openai.com(平台密钥外发第三方,
// 抓包实证)。此前仅设置页保存触发过热更, 掩盖了纯重启路径。
await applyLlmPrefs();
spawnSettingsFromWal(entries);  // F68: spawn policy WAL replay
const bus = new Bus(wal);
bus.load(replay.busEvents);

// Shell registry (C2 implant handles; transport 'local' for benchmark).
// Scope reader mirrors /opt/tools/c2/scope.json — server-side hard gate.
const shellScope = () => {
  // Read-per-call: benchmark windows open/close live; a boot-cached scope
  // would reject freshly authorized exercises.
  // NEW-D(十一轮): 跟随 CONFIG.dataDir——此前硬编码 /var/lib/spectre,
  // 隔离实例的 C2 shell 硬门读到的是生产 scope。
  try { return JSON.parse(readFileSync(path.join(CONFIG.dataDir, 'tools/c2/scope.json'), 'utf8')); }
  catch { return null; }
};

// CS21-1: shell 审计载荷映射见 shells.mjs shellBusAdapter 单源
// (summary/detail 白名单字段; 历史两跳丢失的考古记录也在彼处注释)。
const shellRegistry = createShellRegistry({ bus: shellBusAdapter(bus), listScope: shellScope });  // CS20-11: wal 死参数删

/**
 * CS1-R5: reportWriter/revisionWriter/wakeAgent 三连的机械骨架——
 * 派生会话 create(+溯源/修订目标) → system prompt → 300s 事件等待。
 * 业务判定(事件扫描/回执文案)留在各调用方。
 * @returns {{session: object, timeout: boolean}}
 */
async function runDetachedAgent(o) {
  const s = store.create(o.agentKey, {
    workSessionId: o.ws,
    name: o.name,
    description: o.description,
  });
  // Frozen requester provenance — rides on the writer's published
  // events (discoverer attribution); revisionTarget gates reviseEntry.
  if (o.requester) s.requester = o.requester;
  if (o.revisionTarget !== undefined) s.revisionTarget = o.revisionTarget;
  store.prompt(s, o.prompt, 'system');
  await store.awaitCompletion(s, 300_000);
  // R15-F2: 超时兜底触发时会话仍在跑——不得伪造判定回执。
  return { session: s, timeout: s.busy };
}

/** Last non-empty assistant reply of a session (CS1-R5 ×3 收敛). */
function lastReply(s) {
  const last = [...s.agent.state.messages].reverse()
    .find(m => m.role === 'assistant' && textOf(m).trim());
  return last ? textOf(last) : '';
}

const caps = {
  shells: shellRegistry,
  dispatch: (input) => startAutopwn(input),
  signalEngagement,
  emitBus: (entry) => bus.emit(entry),
  followUp: (sessionId, text) => {
    const record = store.get(sessionId);
    if (!record) {
      throw Object.assign(new Error(`编排器会话不存在: ${sessionId}`),
        { statusCode: 404 });
    }
    store.followUp(record, text);
  },
  /** Read the last N messages of a session (read_session tool backing). */
  readSessionMessages: (sessionId, last, callerWs) => {
    const record = store.get(sessionId);
    if (!record) return null;
    // R12-F1: 项目作用域(F33 同语义)——此前唯一无门的跨项目读取通道,
    // A 项目 agent 凭任意 sessionId 可读 B 项目全部转录(writer 会话/
    // 用户直连会话含内)。null===null 时旧会话互通。
    if ((record.workSessionId ?? null) !== (callerWs ?? null)) return null;
    return record.agent.state.messages.slice(-last)
      .map(m => ({ role: m.role, text: textOf(m) || '' }));
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
    const baseSeq = bus.list().at(-1)?.seq ?? 0;
    const { session: writer, timeout } = await runDetachedAgent({
      agentKey: 'report',
      ws: requesterRecord.workSessionId ?? null,
      name: `报告:${String(hint).slice(0, 20)}`,
      description: `漏洞线索:${String(hint).slice(0, 60)}`,
      requester: { sessionId: requesterRecord.id, author: requesterAuthor },
      prompt:
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
      `5) 用 submit_task_report 提交任务报告收尾。`,
    });
    if (timeout) {
      return { ok: false, timeout: true,
        text: `撰写agent 300s 未完成仍在运行, 本回执不是判定——` +
          `可 read_session(${writer.id}) 复盘, 或稍后 query_intel 核查是否落账` };
    }
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
    const reply = lastReply(writer);
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
    const { session: target } = await runDetachedAgent({
      agentKey,
      ws: requesterRecord.workSessionId ?? null,
      name: `唤醒验证:${agentKey}`,
      description: `配置验证:${String(question).slice(0, 60)}`,
      prompt:
      `【配置验证】配置智能体 ${requesterRecord.agentKey} 刚完成了工具配置变更,需要你从自己的工具面确认状态。\n` +
      `问题:${question}\n\n` +
      `要求:只做验证本身——检查你的技能索引/工具清单,必要时实际调用一次,` +
      `把回执要点如实报告。不要展开其它任务。完成后一句话结论即可。`,
    });
    const reply = lastReply(target) || '(无输出)';
    return {
      ok: Boolean(reply !== '(无输出)'),
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
    const { session: writer, timeout } = await runDetachedAgent({
      agentKey: 'report',
      ws: requesterRecord.workSessionId ?? null,
      name: `修订:${String(target.title ?? '').slice(0, 20)}`,
      description: `漏洞修订申请:${reason.slice(0, 60)}`,
      requester: { sessionId: requesterRecord.id, author: requesterAuthor },
      revisionTarget: target.seq,
      prompt:
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
      `4) 提交任务报告收尾。`,
    });
    if (timeout) {  // R15-F2: 同 reportWriter——超时非判定
      return { ok: false, timeout: true,
        text: `撰写agent 300s 未完成仍在运行, 本回执不是判定——` +
          `可 read_session(${writer.id}) 复盘, 或稍后 query_intel 核查修订` };
    }
    // R15-F3: 身份过滤——emitRevision 的 author 继承原条目作者, 每
    // emitter 的精确身份在 revision.approvedBy。并发修订/用户直编落
    // 同 seq 此前被误记己功(实驳回却回执'已核准')。
    const landed = bus.list().find(e => e.revises === target.seq
      && (e.revision?.n ?? 0) > ((current?.revision?.n) ?? 0)
      && e.revision?.approvedBy?.sessionId === writer.id);
    if (landed) {
      return {
        ok: true,
        text: `修订已获核准并入库:《${landed.title}》(severity=${landed.severity},` +
          `第 ${landed.revision.n} 次修订,seq=${target.seq})。` +
          `审核对话 ${writer.id}。`,
        details: { sessionId: writer.id, revises: target.seq, n: landed.revision.n },
      };
    }
    return {
      ok: false,
      text: `撰写agent驳回了该修订申请。其说明:\n` +
        `${(lastReply(writer) || '(无输出)').slice(0, 600)}\n` +
        `(审核对话 ${writer.id})`,
      details: { sessionId: writer.id, declined: true },
    };
  },
};

const store = new SessionStore({ model, streamFn, modelForAgent, caps, wal,
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
  await rebuildMounts(AGENT_KEYS);
  // rehydrate 早于暖机——重建存量 agent 使 MCP 工具进入老会话工具面
  const remounted = store.rebuildSessionAgents();
  console.log('[sandbox] skill/MCP mounts warmed;',
    `rehydrated agents re-mounted: ${remounted}`);
}).catch(err => console.warn('[sandbox] boot degraded:', err.message));

const compactWal = () => wal.compact([
  ...store.snapshotForDisk(),
  ...bus.list().map(e => ({ t: 'bus', d: e })),
  ...listProjects().map(p => ({ t: 'proj', d: p })),
  ...[...tombstonesAll()].map(id => ({ t: 'proj-del', d: { id } })),  // R9-F5: 墓碑过 compact
  { t: 'pref', d: getPrefs() },
  { t: 'spawn', d: getSpawnSettings() },  // F68: compact 白名单补 spawn
]);
compactWal();
process.on('SIGTERM', () => {
  // R27-F2: WAL 关闭必须后于连接排空——此前先 close 再等 server, 排空
  // 窗口(≤1.5s)内完成的消息 safeWalAppend 吞异常后永久丢(已流给 SSE
  // 的回复重启消失), Bus.emit 直连 append 抛错 500。compact 后 fd 以 a
  // 模式重开, 窗口期增量落在其上, WAL 形状=快照基线+增量尾, replay 兼容。
  try { compactWal(); } catch { /* best effort */ }
  const seal = () => { try { wal.close(); } catch { /* already closed */ } process.exit(0); };
  server.close(() => seal());
  setTimeout(seal, 1500).unref();
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
  console.log(`[agent-runtime] model=${effectiveCommon().model || '(未配置——设置页配)'} temporal=${CONFIG.temporalAddress}`);
});
