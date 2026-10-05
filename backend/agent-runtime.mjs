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
import { entryKind as entryKindOf } from './src/tools.mjs';
import { emitRevision } from './src/revision.mjs';
import { buildPi, textOf, applyLlmPrefs } from './src/pi.mjs';
import { createShellRegistry, shellBusAdapter } from './src/shells.mjs';  // CS24-F1: 合并双 import
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

// Shell registry (C2 植入通道句柄; transport 缺省 'web'——CS24-F4 统一口径)。
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
  // 自测-2: awaitCompletion 的空闲快路径与 prompt() 微任务置 busy 之间有
  // 窗口——首次调用曾因此即时空收割(writer 还没开跑, 回执"非判定"而
  // 落账随后发生, 重试才查到)。先等 busy 置位(≤5s), 再挂完成等待。
  // r28-#2: 首调竞态——5s 内 busy 未置位即提前空收割(同参重试成功=
  /// 竞态指纹)。窗口 20s, 且"已产出事件"即视为已启动。
  for (let i = 0; i < 200 && !s.busy && !(s.events?.length > 1); i++) {
    await new Promise(r => setTimeout(r, 100).unref?.());
  }
  await store.awaitCompletion(s, 300_000);
  // 超时/空收割兜底: writer 可能仍在后台落账——再宽限 10s 轮询回执侧
  // 事件(landed 判定由调用方做), 避免把"稍后落账"误报为"未落账"。
  for (let i = 0; i < 10 && s.busy; i++) {
    await new Promise(r => setTimeout(r, 1000).unref?.());
  }
  // R15-F2: 超时兜底触发时会话仍在跑——不得伪造判定回执。
  return { session: s, timeout: s.busy };
}

/** Last non-empty assistant reply of a session (CS1-R5 ×3 收敛). */
function lastReply(s) {
  // R32D85-E1(P1): textOf 收 content(string|parts), 此前传整消息对象
  // 恒 ''——lastReply/readSessionMessages/wake 三面自 cb381c5 起死读。
  const last = [...s.agent.state.messages].reverse()
    .find(m => m.role === 'assistant' && textOf(m.content).trim());
  return last ? textOf(last.content) : '';
}

const caps = {
  persistMetaNow: (record) => store.persistMetaNow?.(record),  // r20-②
  shells: shellRegistry,
  dispatch: (input) => startAutopwn(input),
  signalEngagement,
  // r29-#2: vuln 落账互斥——emit 前预检, 短窗高重叠拦截(非吞并),
  // 返回 {blocked, dupSeq} 供 publish_vulnerability 回执指引 revise。
  emitBus: (entry) => {
    if (entry?.type === 'vulnerability' && !entry.revises) {
      const block = bus.vulnMutexCheck?.(entry);
      if (block) return block;
    }
    return bus.emit(entry);
  },
  followUp: (sessionId, text) => {
    const record = store.get(sessionId);
    if (!record) {
      throw Object.assign(new Error(`编排器会话不存在: ${sessionId}`),
        { statusCode: 404 });
    }
    // r6v4-#9: 中段情报 DM(publish_intel→此处)的真实入口——主控长
    // 回合(busy)中排队 5min+ 的消息预打迟到标(store 层三穿后的实证
    // 调用链兜底, 双保险)。
    let t = text;
    // r6v5-#9: 诊断日志(四连穿后按建议先实证)——caps 入口判定三要素
    // 落 journal, 下轮穿透可直接读数。
    const wdTurnMs = record.turnStartedAt ? Date.now() - record.turnStartedAt : -1;
    const wdHit = record.busy && wdTurnMs > 5 * 60_000
      && !t.startsWith('[迟到') && !t.startsWith('[engagement ');
    store._journal(record, 'wd_probe', { busy: record.busy, turnMs: wdTurnMs, hit: wdHit,
      textHead: truncateTextForJournal(t) });
    if (wdHit) {
      t = `[迟到中段消息](注入时主控回合已进行 ${Math.round(wdTurnMs / 60_000)}min, 注意与情报库终态对账)\n${text}`;
    }
    store.followUp(record, t);
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
      .map(m => ({ role: m.role, text: textOf(m.content) || '' }));
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
    // 自测-3: 失速看门狗——火后即忘的子会话此前 40+ 分钟无心跳也无
    // 任何处置。30min 无 journal 事件→注入 nudge; 60min→终止并向
    // 派生者发 DM(会话空闲/结束时定时器自清)。
    const WD_NUDGE_MS = 30 * 60_000;
    const WD_KILL_MS = 60 * 60_000;
    const wd = setInterval(() => {
      const last = child.events?.[child.events.length - 1];
      const idleMs = last ? Date.now() - Date.parse(last.ts) : 0;
      if (!child.busy || store.get?.(child.id) == null) {
        clearInterval(wd);
        return;
      }
      if (idleMs >= WD_KILL_MS) {
        clearInterval(wd);
        child.busy = false;
        store._journal(child, 'watchdog_kill', { idleMs });
        bus.emit({
          channel: 'dm', from: 'system', to: parentRecord.agentKey,
          type: 'watchdog',
          summary: `看门狗: 子任务 ${meta.name ?? agentKey}(${child.id.slice(0, 16)}…) 60 分钟无事件, 已终止。请评估是否重派。`,
          workSessionId: parentRecord.workSessionId ?? null,
        });
      } else if (idleMs >= WD_NUDGE_MS && !child._wdNudged) {
        child._wdNudged = true;
        store.followUp(store.get(child.id) ?? child,
          '【看门狗】30 分钟无事件——请汇报当前状态与阻塞点; 已无法推进请立即提交任务报告收尾。');
        bus.emit({
          channel: 'dm', from: 'system', to: parentRecord.agentKey,
          type: 'watchdog',
          summary: `看门狗: 子任务 ${meta.name ?? agentKey} 30 分钟无事件, 已注入状态询问。`,
          workSessionId: parentRecord.workSessionId ?? null,
        });
      }
    }, 60_000).unref?.();
    return child;
  },

  /**
   * Vulnerability-writer wake (report_vulnerability tool backing).
   * Creates a DETACHED writer session — no parentSessionId, no
   * engagementId, no orchestratorSessionId — so it never joins any
   * dispatch tree (parentNodeId null ⇒ rootIdOf = itself ⇒ countTree
   * and DispatchTreePanel ignore it) and never touches spawn quotas.
   * Bounded wait (CS81-F2): resolves at the writer's agent_end
   * (event-driven) or the 300s cap — agent_end may never fire on
   * stuck/error paths. Verdict:
   * the writer's published vulnerability event, or its decline reason.
   */

  reportWriter: async (requesterRecord, hint) => {
    const requesterAuthor = store.authorOf(requesterRecord);
    const baseSeq = bus.list().at(-1)?.seq ?? 0;
    const tRw = Date.now();  // r14-④: 同步等待可观测(回执附 waitedMs)
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
      `4) 成立 → 调用 publish_vulnerability 落账:自行拟定标题与 severity。` +
      `若回执以 [mutex-intercepted] 开头=与库内既有条目同点位被拦(未成账): ` +
      `终报必须如实写「被互斥拦截待归并」, 并 query_intel 回查正本 seq——严禁写「已落账」; ` +
      `正常落账后也须以回执 seq 回查库内确认再写终报。` +
      `标题必须一行式简洁命名(参考 CVSS/CVE 业界惯例): 资产+端点+漏洞类型(CWE 编号可选), ` +
      `≤40 字, 禁止句子化描述/影响铺陈(那些放正文)。正例:'SpectreTest /api/transfer 无鉴权 BOLA'/'登录页 SQL 注入(CWE-89)'; 反例:'发现某接口存在一个非常重要的未授权访问漏洞可以挪动资金'。` +
      `正文包含发现过程、证据链、危害分析与POC,并注明发现者 ${requesterAuthor.name};\n` +
      `   不成立 → 不发布,在最终回复中明确说明判定理由(该理由将回执给发现者);\n` +
      `5) 用 submit_task_report 提交任务报告收尾。`,
    });
    if (timeout) {
      // r43-U1: 完成回投——writer 后台完成落账时 DM 通知发现者会话,
      // 编排回合不再干等(同步预算 300s 内长任务曾钉死 263s)。
      const wRec = store.get(writer.id);
      Promise.resolve(wRec ? store.awaitCompletion(wRec, 600_000) : null).then(() => {
        const hit = bus.list().find(e => e.seq > baseSeq
          && e.type === 'vulnerability' && e.author?.sessionId === writer.id);
        caps.followUp(requesterRecord.id,
          `[writer 完成] 你上报的线索${hit
            ? `已落账:《${hit.title}》(seq=${hit.seq}, severity=${hit.severity})`
            : '终审未立为漏洞(writer 最终输出见下)'}` +
          `${hit ? '' : `\n${(lastReply(writer) || '(无输出)').slice(0, 300)}`}\n(撰写对话 ${writer.id}, read_session 可复盘)`);
      }).catch(() => {});
      return { ok: false, timeout: true,
        text: `撰写agent 300s 未完成仍在运行, 本回执不是判定——` +
          `其完成后我会自动 DM 通知你(无需轮询); 也可 read_session(${writer.id}) 复盘, 或稍后 query_intel 核查` };
    }
    const published = bus.list().find(e => e.seq > baseSeq
      && e.type === 'vulnerability' && e.author?.sessionId === writer.id);
    // r43-O1: 幂等归并透明化——writer 的 publish 撞 emit 幂等(同文重发/
    // 同 title+severity)时 bus 无新事件, 此前走 declined 分支回执
    // "未立为漏洞", 归并事实要靠编排者自行回查才发现。落账没发生≠
    // 线索无效: 查 writer 期内最近 3min 的同项目 vuln(无 author 过滤)——
    // 命中即归并回执。
    if (!published) {
      const dupHit = [...bus.list()].reverse().find(e =>
        e.type === 'vulnerability' && !e.revises
        && e.workSessionId === (requesterRecord.workSessionId ?? null)
        && Date.parse(e.ts ?? 0) > tRw - 60_000);
      if (dupHit) {
        return {
          ok: true, merged: true,
          text: `线索已归并:《${dupHit.title}》(正本 seq=${dupHit.seq}, severity=${dupHit.severity})——` +
            `writer 判定与既有条目为同点位重复, 未另立正本(零双账)。你的发现者身份经 coDiscoverers/` +
            `修订链保留, read_session ${writer.id} 可复盘其查重论证。`,
          details: { sessionId: writer.id, mergedInto: dupHit.seq, waitedMs: Date.now() - tRw },
        };
      }
    }
    if (published) {
      return {
        ok: true,
        text: `漏洞报告已产出并入库:《${published.title}》` +
          `(severity=${published.severity},seq=${published.seq};同步等待 ${Math.round((Date.now() - tRw) / 1000)}s)。` +
          `撰写对话 ${writer.id}(read_session 可复盘其思考与验证过程)。`,
        details: { sessionId: writer.id, seq: published.seq,
          title: published.title, severity: published.severity,
          waitedMs: Date.now() - tRw, stage: 'writer-review' },  // r14-④ 成功分支同样附同步等待
      };
    }
    // Declined / failed: relay the writer's final reasoning back.
    const reply = lastReply(writer);
    // r29e-1: 互斥拦截专属回执——被拦方必须知道「未成账+荣誉路径」。
    // 通用 declined 前缀「未将此线索立为漏洞」与被拦正文并置, 曾致
    // 三次「已落账」误报接力(4908→回执→DM), 荣誉面临静默丢失。
    if (reply && /mutex-intercepted/i.test(reply)) {
      return {
        ok: false, mutexIntercepted: true,
        text: `[mutex-intercepted] 你的上报与库内既有条目同点位, 已被落账互斥拦截(命中方式: ${/by=fingerprint/.test(reply) ? '端点指纹命中' : 'token 重叠命中'})——**未成账**(同步等待 ${Math.round((Date.now() - tRw) / 1000)}s)。` +
          `发现不会丢失: query_intel(kind=vulnerability, q=点位/标题关键词)查漏洞正本 seq(注意甄别: 任务报告 seq 不算正本), ` +
          `用 request_vulnerability_revision 将你的证据与署名并入(共同发现者荣誉); 严禁重复 publish。` +
          `(writer 处理记录摘要: ${reply.slice(0, 220)})`,
        details: { sessionId: writer.id, mutex: true, waitedMs: Date.now() - tRw },
      };
    }
    // r18-1: 半成品检测——草稿/中断文本混入回执两轮未收敛, 判定词缺位
    // 时如实标注(不再把未完成输出当判定说明)。
    // r29b-残留③: 判定词族扩充——writer 以"重复/并入/维持/证据不足"等
    // 清晰结论措辞驳回时曾被误贴"疑似未完成"旗标(验收方实测报)。
    const looksDraft = reply && !/(不成立|驳回|不予|拒绝|decline|不构成|否决|重复|合并|并入|归并|维持|既有|已存在|已由|另立|证据不足|不足以|duplicate|merge|overlap)/i.test(reply);
    const replyShown = looksDraft
      ? `(writer 最终输出疑似未完成(未见判定词)——全文见 read_session ${writer.id}, 稍后复核):\n${reply.slice(0, 300)}`
      : (reply || '(无输出)');
    return {
      ok: false,
      text: `报告agent未将此线索立为漏洞(同步等待 ${Math.round((Date.now() - tRw) / 1000)}s)。其判定说明:\n` +
        `${replyShown.slice(0, 600)}\n` +
        `(撰写对话 ${writer.id};若你有更强证据可再次上报,` +
        `或用 publish_intel 留存线索)`,
      details: { sessionId: writer.id, declined: true, waitedMs: Date.now() - tRw },  // r28-#2: 归位——此处属 reportWriter(tRw);500 行属 revisionWriter(tRv)
    };
  },

  /** wake_agent tool backing — the mandatory post-config verification
   *  step: spawn a DETACHED business-agent session (no dispatch tree,
   *  no quota — same detach rules as the report writer), ask it to
   *  confirm its own toolface state, await its reply, return it. */
  wakeAgent: async (requesterRecord, agentKey, question) => {
    const { session: target, timeout } = await runDetachedAgent({
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
    // CS67-3: 超时兜底对齐 reportWriter 孪生(R15-F2)——此前解构丢
    // 弃 timeout, 半成品回复包装成'验证答复'(会话仍在跑, 伪造判定)。
    if (timeout) {
      return { ok: false, timeout: true,
        text: `${agentKey} 验证会话 300s 未完成仍在运行, 本回执不是验证结论——` +
          `稍后用 read_session(sessionId: ${target.id}) 复盘其最终回复。` };
    }
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
    // r35-N8: text 整体替换的三层实证陷阱(L0/L1/L2 各咬一次)——回执
    // 附新旧长度对比, 骤降>30% 显式警告(不是拦, 是让替换可见可悔)。
    let lenNote = '';
    if (params.text !== undefined) {
      // r45-N8b: 基线取现行版(修订链最新)而非 bus 索引的原始版——
      // 回执 2565→4608 vs 实测现行 4118 的三证歧义根因(target 恒指首落)。
      let cur = target;
      for (const e2 of bus.list()) {
        if (e2.revises === target.seq
          && (e2.revision?.n ?? 0) > (cur.revision?.n ?? 0)) cur = e2;
      }
      const oldLen = String(cur.detail ?? '').length;
      const newLen = String(params.text).length;
      const drop = oldLen > 0 ? (oldLen - newLen) / oldLen : 0;
      lenNote = ` 正文长度 ${oldLen}→${newLen}` +
        (drop > 0.3 ? ` ⚠骤降 ${Math.round(drop * 100)}%——text 是整体替换, 疑似误抹原文; 若是误操作请立即再修订补回(修订链完整保留)。` : '');
    }
    return {
      text: `修订已入库(seq=${target.seq} 第 ${event.revision.n} 次修订):` +
        `《${event.title ?? ''}》。原版保留在链上,query_intel 显示现行版。${lenNote}`,
      details: { revises: target.seq, n: event.revision.n },
    };
  },

  /** request_vulnerability_revision backing — writer review wake.
   *  Same detached-session + event-driven-wait pattern as reportWriter. */
  revisionWriter: async (requesterRecord, targetSeq, reason, changes) => {
    const tRv = Date.now();  // r14-④
    const reasonS = String(reason ?? ''); const changesS = String(changes ?? '');  // r20-①: 参数防御
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
      description: `漏洞修订申请:${reasonS.slice(0, 60)}`,
      requester: { sessionId: requesterRecord.id, author: requesterAuthor },
      revisionTarget: target.seq,
      prompt:
      `【漏洞修订审核 · seq=${target.seq}】你是报告撰写专职 agent。` +
      `${requesterAuthor.name}(${requesterAuthor.typeLabel})申请修订漏洞:\n` +
      `『${target.title}』(severity=${target.severity ?? '?'},现行版内容如下)\n` +
      `---现行内容---\n${(current ?? target).detail ?? target.summary ?? '(空)'}\n---\n` +
      `申请理由:${reasonS}\n要求更改:${changesS}\n\n` +
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
      details: { sessionId: writer.id, declined: true, waitedMs: Date.now() - tRv },  // r28-#2: tRw→tRv(跨函数错带变量)
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
  // r20-②: 在役 engagement 中断通知——重启杀死的战役此前零告知(靠
  // 对账铁则兜底)。activeEngagement 已持久化(FP 批), boot 扫描并 DM。
  for (const rec of store.sessions.values()) {  // r20v5: list() 是 summary 投影(无 activeEngagement)——取真身
    const eng = rec?.activeEngagement?.engagementId;
    if (!eng) continue;
    if (rec._bootInterruptNotified) continue;
    // r25-重放根修: 同战役中断通知查重(标题含 engagementId, 命中即跳)
    // ——_bootInterruptNotified 仅内存态, 此前每次重启对同战役重发
    // (4198 战役 ×9 重放实证)
    const dupKey = `平台重启:你的战役 ${eng} 的 Temporal 执行已被中断`;
    if (bus.list().some(e => (e.summary ?? '').startsWith(dupKey))) continue;
    rec._bootInterruptNotified = true;
    bus.emit({ channel: 'dm', from: 'system', to: rec.agentKey, type: 'watchdog',
      summary: `${dupKey}——成员产出以情报库为准(query_intel 对账), 失联成员可重派。`,
      workSessionId: rec.workSessionId ?? null });
    // r20v4: bus 事件不进会话——同时 followUp 直接注入编排器(idle 即
    // 触发回合, 看得见才算通知)
    try {
      store.followUp(rec, `[DM from system] 平台重启:你的战役 ${eng} 的 Temporal 执行已被中断——成员产出以情报库为准(query_intel 对账), 失联成员可重派。`);
    } catch { /* 会话不可注入时 bus 事件兜底 */ }
  }
  const ensured = await ensureSandbox();
  console.log(`[sandbox] driver=${cfg.driver} ok=${ensured.ok}`,
    ensured.error ?? '');
  // 自测-7: 容器重建→bus 通知(全 agent 可见)+依赖容器态的 shell 标记
  // 不可用(注册表持久但进程/文件已失——此前零通知)。
  // r6v2-观测11: 平台重启预告——沙箱进程/临时文件随重启重置, 战场
  // 进程若跑在 /tmp 会被带走(部署前应预告; 事后 bus 告知可对账)。
  // r6v4-观测11: 归属当前活跃项目(query_intel 项目作用域可见——
  // 此前 workSessionId:null 在任何项目内都查不到, 三轮"零预告"根因)
  const { getPrefs } = await import('./src/projects.mjs');
  const curWs = getPrefs().currentWs ?? null;
  // r14v2: 重启通知去重(同标题 10 分钟内不重发——三连重启曾三连落账)
  const recentSame = bus.list().some(e => e.title === '平台运行时已重启'
    && Date.now() - Date.parse(e.ts) < 10 * 60_000);
  if (!recentSame) bus.emit({ channel: 'audit', from: 'system', type: 'intel-note',
    author: { key: 'system', name: '平台运维', typeLabel: '系统' },
    title: '平台运行时已重启',
    summary: '平台运行时已重启:沙箱临时态(/tmp 进程与文件)已重置',
    detail: '平台刚完成重启部署。/tmp 下的自建靶场进程与临时文件已被重置;需要保留的战场环境请提前落工作区或等部署窗口。本条经 query_intel 可查。',
    workSessionId: curWs });
  if (ensured.recreated) {
    const { markTransportDead } = await import('./src/shells.mjs');
    const dead = markTransportDead();
    bus.emit({
      channel: 'audit', from: 'system', type: 'context',
      summary: `沙箱容器已重建(此前进程/文件态全失):${dead} 个依赖容器态的 shell 通道标记失效, 请重新注册。`,
    });
  }
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
// R32D58-F1(P0) 兜底: 任何漏网异步异常打日志而非杀进程——核心资产是
// 自身存活率; F1 主修(URL 解析守卫)之外的最后防线。
process.on('unhandledRejection', (reason, origin) => {
  console.error(`[runtime] unhandledRejection(${origin}):`, reason);
});
process.on('uncaughtException', err => {
  console.error('[runtime] uncaughtException:', err);
});
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
function truncateTextForJournal(t) { return String(t).slice(0, 60); }

const route = createRouter({ store, bus, caps, wal });

const server = http.createServer(async (req, res) => {
  // R32D58-F1(P0): new URL 对含字面 ESC 等控制字符的路径抛 ERR_INVALID_URL
  // ——此前在 try 外, 单个可打印请求即可 unhandledRejection 击杀整个
  // runtime(0x727 OSC-8 模板可自然触发)。解析失败回 400, 进程存活。
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `bad request url: ${JSON.stringify(req.url)}` }));
    return;
  }
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

// R32D95-N4: PORT=abc → Number=NaN → listen 同步抛落入 uncaughtException
// 兜底仅打日志 → exit 0(systemd 判绿)——server.on('error') 接不住同步
// 异常。启动前显式校验。
if (!Number.isInteger(CONFIG.port) || CONFIG.port < 1 || CONFIG.port > 65535) {
  console.error(`[agent-runtime] FATAL: PORT=${process.env.PORT ?? ''} 非法(须 1-65535 整数)`);
  process.exit(1);
}
server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`[agent-runtime] http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`[agent-runtime] model=${effectiveCommon().model || '(未配置——设置页配)'} temporal=${CONFIG.temporalAddress}`);
});
// R32D79-N1: bind 失败(EADDRINUSE 等)须 FATAL 非零退——此前异常落
// uncaughtException 兜底仅打日志, 进程 exit 0 被 systemd 视作成功,
// 半正常引导日志误导排障(对比 WAL 双机锁面是干净 FATAL)。
server.on('error', err => {
  console.error(`[agent-runtime] FATAL: 无法监听 ${CONFIG.host}:${CONFIG.port} — ${err.code ?? ''} ${err.message}`);
  console.error('[agent-runtime] 端口被占用时: 找到持有进程(lsof -i :PORT 或 ss -ltnp)或换 PORT env');
  process.exit(1);
});
