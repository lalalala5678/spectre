/**
 * SPECTRE orchestration workflows.
 *
 * autoPwnWorkflow (parent)
 *   - announces the engagement (公告) and dispatches one agentTaskWorkflow
 *     child per selected stage agent (私信 dispatch)
 *   - message policy (per product decision):
 *       · child → orchestrator: report_vulnerability/publish_intel tool → bus 私信
 *         + followUp into the orchestrator pi session (LLM decides relays;
 *           report_vulnerability 走独立 writer 会话, CS2-#4)
 *       · orchestrator → children: relay_to_agents tool → orchestratorRelay
 *         signal → targeted dm into child pi sessions
 *       · child ↔ child: never direct; shares journal on the bus (共享) but
 *         are NOT auto-fan-out — relaying is the orchestrator's call
 *       (CS61-F1: 旧 broadcast/agentShare/agentResult 信号 v1.0 遗留零发射方, 已删)
 *   - on completion: notifies the orchestrator session (auto-summary)
 *
 * agentTaskWorkflow (child, one per stage agent)
 *   - creates an engagement-marked pi session (carries report tool)
 *   - prompts it with the instruction, steers incoming dms into it
 *   - returns its summary
 *
 * Determinism rules: static imports only, sync signal handlers pushing to
 * queues, async drain tasks in the body, no Date.now / Math.random.
 */

import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  startChild,
} from '@temporalio/workflow';
// CS1-A4: 单源常量——nudge-text.mjs 纯字符串模块(零副作用), Temporal determinism 安全。
import { REPORT_NUDGE_TEXT } from './src/nudge-text.mjs';

// CS61-F1: agentShare/agentResult/broadcast 三信号 v1.0 遗留——全仓
// 零发射方(唯一发射方是 orchestratorRelay, tools.mjs relay_to_agents),
// handler+drain 分支+头注释一并删除。
const signals = {
  dm: defineSignal('dm'),
  orchestratorRelay: defineSignal('orchestratorRelay'),
};

const llm = proxyActivities({
  startToCloseTimeout: '650s',
  retry: { maximumAttempts: 1 },
});

const quick = proxyActivities({
  startToCloseTimeout: '30s',
  retry: { maximumAttempts: 2 },
});

/**
 * Local twin of the runtime's clipMarked (workflows must not import
 * runtime modules — architecture rule). One-line digests fed into the
 * orchestrator's completion DM are never cut silently.
 */
function clipMarked(value, max, note) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  // CS66-F3: 已显示/总长并列; CS67-7: 补全手段 note(pi.mjs 同形)。
  const pointer = note ? `,${note}` : '';
  return `${text.slice(0, max)}[已截断:${max}/${text.length} 字符${pointer}]`;
}

/**
 * Per-child digest cap in the engagement-done DM. Real replies run 0.5-1.3k
 * chars (project-3 test: 473/635/1284-char originals all clipped at the old
 * 200 cap); 2000 keeps normal replies whole while the whole notice stays far
 * below the 32k prompt cap even for several children.
 */
const CHILD_SUMMARY_MAX = 2000;


/**
 * @param {{engagementId: string, instruction: string, agents: string[],
 *          orchestratorSessionId?: string|null,
 *          workSessionId?: string|null}} input
 */
export async function autoPwnWorkflow(input) {
  const { engagementId, instruction, agents, orchestratorSessionId,
          workSessionId } = input;
  const engagement = `autopwn-${engagementId}`;
  const children = new Map();     // agentKey -> child handle
  const childTiming = new Map();  // EW-3: agentKey -> {start, end}
  const inbox = [];               // {kind, from, to, text}(CS62-#1: share/result 已删, 形状收窄)
  let open = true;

  setHandler(signals.orchestratorRelay, (msg) => {
    inbox.push({ kind: 'relay', from: 'orchestrator', ...msg });
  });

  // Single drain task: journal events + route dms per policy above.
  const drain = (async () => {
    while (open || inbox.length > 0) {
      await condition(() => inbox.length > 0 || !open);
      if (inbox.length === 0) break;
      const msg = inbox.shift();
      // CS61-F1: 仅剩 relay 分支(share/result/broadcast 三 kind 零发射
      // 方, handler 与分支一并删除)。
      for (const key of msg.to ?? []) {
        const handle = children.get(key);
        if (handle) {
          try {  // R7-F2: 已完成/失败 child 接受 signal 会抛错并拖垮整
            // 个父工作流(notify+汇总全丢)——best-effort 跳过。
            await handle.signal(signals.dm, { from: 'orchestrator', text: msg.text });
          } catch { /* child closed — skip */ }
        }
      }
    }
  })();

  await quick.busEmit({
    channel: 'announce', from: 'orchestrator', type: 'context',
    summary: `公告:任务已受理。目标指令:${instruction.slice(0, 120)}`,
    engagement, workSessionId,
  });

  const results = new Map();
  // R7-F5: 重复 agentKey(LLM 传重复数组)会撞 workflowId 抛
  // 'workflow already started' → Promise.all 一败全弃 + 已启动的健康
  // child 被默认 TERMINATE 连坐杀。入口去重。
  const uniqueAgents = [...new Set(agents)];
  await Promise.all(uniqueAgents.map(async (agentKey) => {
    await quick.busEmit({
      channel: 'dm', from: 'orchestrator', to: agentKey, type: 'dispatch',
      summary: `任务派发:${instruction.slice(0, 80)}`, engagement,
      workSessionId,
    });
    const handle = await startChild(agentTaskWorkflow, {
      args: [{ agentKey, engagementId, instruction, orchestratorSessionId,
               workSessionId }],
      workflowId: `agent-${engagementId}-${agentKey}`,
      taskQueue: 'spectre',
    });
    children.set(agentKey, handle);
    // EW-3: 成员起止时间戳(四轮合规建议最后一项)——完成通知随行
    childTiming.set(agentKey, { start: new Date().toISOString() });
    try {
      const result = await handle.result();
      childTiming.get(agentKey).end = new Date().toISOString();
      results.set(agentKey, result);
      {
        // R7-F1: 无条件发完成 share——resume 完成判定依赖 channel='share'
        // 事件(publish_intel 落的是 dm+intel-note, 不可替代)。
        await quick.busEmit({
          channel: 'share', from: agentKey, type: 'result',
          title: `${agentKey} 产出`,
          summary: `产出:${(result.summary || '').slice(0, 160)}`,
          detail: result.reply || result.summary || null,
          payloadRef: `sess:${result.sessionId}`, engagement,
          workSessionId,
        });
      }
    } catch (err) {
      results.set(agentKey, { agentKey, error: String(err) });
    }
  }));

  open = false;
  await drain;

  await quick.busEmit({
    channel: 'announce', from: 'orchestrator', type: 'context',
    summary: `公告:全部 ${uniqueAgents.length} 个智能体任务结束,engagement ${engagementId} 关闭。`,
    engagement, workSessionId,
  });

  // Q2(a): completion notice auto-injected into the orchestrator session.
  // r6v2-#10: 情报库终报对账——workflow 失败(心跳丢失/worker 重启的
  // ChildWorkflowFailure)与终报已落账可并存, 以库为准消灭假警报。
  let recon = {};
  try { recon = await quick.engagementChildren?.(engagementId) ?? {}; } catch { recon = {}; }
  const summaryLines = [...results.entries()]
    .map(([key, value]) => {
      const t = childTiming.get(key);
      const ts = t ? ` [${t.start.slice(11, 19)}→${(t.end ?? '?').slice(11, 19)}]` : '';
      if (value.report) {
        return `- ${key}${ts}: 任务报告已入库(${value.report.status})《${clipMarked(value.report.title, 60, 'query_intel 读详情')}》—详情用 query_intel 读取`;
      }
      // CS68-F4: summary 在 child 侧已单层截断(agentTaskWorkflow 返回
      // 处), 此处再 clip 会切掉首层标记且总长谎报(5000→'2000/2018')
      // ——原样用。CS69-3: 去行号引用(自引必漂); CS69-4: error 非
      // 会话消息且无 sessionId, 补全手段不得指 read_session。
      if (value.error) {
        const r = recon[key];
        if (r) return `- ${key}${ts}: 运行状态异常(${clipMarked(value.error, 80, '…')}), 但终报已落账(${r.status ?? '?'})《${clipMarked(r.title ?? '', 50, '…')}》(seq=${r.seq})——以情报库为准, 勿判失败`;
        return `- ${key}${ts}: ${clipMarked(value.error, CHILD_SUMMARY_MAX, '完整错误见 worker 日志')}(库内无终报——真失败)`;
      }
      return `- ${key}${ts}: ${value.summary ?? ''}`;
    })
    .join('\n');
  try {
    await quick.notifyEngagementDone({
      orchestratorSessionId,
      engagementId,
      summary: summaryLines,
    });
  } catch {
    // R7-F4: 编排会话 404/runtime 停机曾把已完成战役标 FAILED——
    // 汇总全丢。bus 兜底(落 WAL, 面板可见, 不依赖会话存活); 再失败
    // 也让 workflow 正常完成(结果在返回值+bus)。
    try {
      await quick.busEmit({
        channel: 'announce', from: 'orchestrator', type: 'context',
        title: `战役汇总(编排会话投递失败兜底): ${engagementId}`,
        summary: clipMarked(summaryLines.join('\n'), 480, 'query_intel 读全文'),  // CS44-F15: 打标截断(再 slice 会切掉标记)
        engagement, workSessionId,
      });
    } catch { /* 战役确已完成: 结果在返回值+先前的关闭公告 */ }
  }

  return {
    engagementId,
    agents: [...results.entries()].map(([key, value]) => ({ agentKey: key, ...value })),
  };
}

/**
 * @param {{agentKey: string, engagementId: string, instruction: string,
 *          orchestratorSessionId?: string|null,
 *          workSessionId?: string|null}} input
 */
export async function agentTaskWorkflow(input) {
  const { agentKey, engagementId, instruction, orchestratorSessionId,
          workSessionId } = input;
  const session = await llm.createSession(agentKey, {
    engagementId,
    orchestratorSessionId,
    workSessionId,
  });
  // Task-report invariant baseline: count before the task runs.
  const base = await quick.reportState(session.sessionId);

  const inbox = [];
  let dmSeq = 0;  // 自测-8: 投递序号——orchestrator 长回合期间积压的 DM
  // 在回合尾批量涌入时保持到达顺序可辨(此前终报先落过程后至, 无从对账)。
  let finished = false;
  setHandler(signals.dm, (msg) => {
    inbox.push({ ...msg, seq: ++dmSeq });
  });

  // Steer incoming orchestrator dms into the live pi session while it works.
  const drain = (async () => {
    while (!finished) {
      await condition(() => inbox.length > 0 || finished);
      if (finished) break;
      const msg = inbox.shift();
      if (msg) {
        // EW-1: 序号统一由 runtime routes 层补(单一计数器, per-target
        // 单调)——此处若自带 #n 会被 routes 正则跳过, 造成 per-child
        // 重复序号(r4 实测两条 #1)。
        await llm.steerSession(session.sessionId, `[DM from ${msg.from}] ${msg.text}`);
      }
    }
  })();

  let result;
  let report;
  try {
    try {
      result = await llm.promptAndWait(
        session.sessionId,
        // Fix-A (P1+P6): recipient identity injected. Project-3 exposed
        // the full multi-role instruction to every agent WITHOUT naming
        // the recipient — all three self-identified as the dispatcher and
        // burned 12 spawn calls. Keep the 【AutoPwn 任务 prefix first:
        // report-compliance rules and frontend fallback regexes key on it.
        `【AutoPwn 任务 · ${engagementId}】你是本任务 ${agentKey} 阶段智能体。` +
        `下方指令中的多角色分工由平行智能体各自执行,你只负责 ${agentKey} ` +
        `对应的部分;除非指令明确要求,不要派生子智能体、不要代行其它角色` +
        `的交付物。\n${instruction}`,
      );
    } catch (e) {
      // R7-F3: 活动失败(650s 超时/5xx)此前直接穿透——会话已落库但
      // 报告门未跑, taskReportCount 恒 0, activeOnly 配额槽跨重启
      // 永久占用(P2 同类复发通道)。best-effort 标记后重抛(父流程
      // 已容忍 child 失败; resume 会把失败 agent 判未完成重跑)。
      try {
        await quick.markReportSynthesized(session.sessionId,
          { title: `[失败] ${agentKey} 任务报告`, status: 'failed' });
      } catch { /* 收尾尽力 */ }
      throw e;
    }
    // Task-report gate: a task may only finish with a report on file.
    // Nudge ≤2 (followUp fires an idle agent; steer would only queue),
    // then synthesize from the final reply so readers never see a hole.
    // CS23-N15: 2 = reportNudgeMax 的 workflow 侧 twin(架构禁 import
    // runtime 侧模块, 同 clipMarked 先例)——改值须两处同步。
    for (let nudge = 0; nudge < 2; nudge++) {
      report = await quick.reportState(session.sessionId);
      if (report.count > base.count) break;
      await quick.followUpSession(session.sessionId, REPORT_NUDGE_TEXT);
      result = await llm.waitIdle(session.sessionId);
    }
    report = await quick.reportState(session.sessionId);
    if (report.count <= base.count) {
      // CS41-B7 同步钉注: 本块与 src/sessions.mjs synthesizeReport 双实现
      // (口径差异: 标题 spawnName ?? agentKey / 催办次数 CONFIG.reportNudgeMax
      // / broken 分支)——改任何一侧必须同步另一侧(先例 CS23-N15)。
      await quick.busEmit({
        channel: 'share', from: agentKey, type: 'task-report',
        author: report.author, status: 'no-result',
        title: `[系统代拟] ${agentKey} 任务报告`,
        summary: 'agent 未提交,系统依据最终回复代拟',
        detail: '**状态**:no-result(系统代拟)\n\n## 说明\n催办 2 次后仍未调用 ' +
          `submit_task_report,任务报告由系统代拟。\n\n## 最终回复原文\n${result.reply ?? '(无输出)'}`,
        engagement: `autopwn-${engagementId}`,
        // F65: 该事件此前缺 workSessionId → 合成报告在任何项目面板
        // 都不可见(F64b 实测: seq2207 ws=None, 同战役其余事件全带)。
        workSessionId: workSessionId ?? null,
      });
      // The bus event carries the report, but the runtime record counter did
      // not follow — which would keep the session "active" forever under the
      // activeOnly spawn quota (P2 narrow revival). Mark it on the runtime
      // side so the slot is released.
      await quick.markReportSynthesized(session.sessionId, {
        title: `[系统代拟] ${agentKey} 任务报告`, status: 'no-result',
      });
      report = { ...report, lastReport: { title: `[系统代拟] ${agentKey} 任务报告`, status: 'no-result' } };
    }
  } finally {
    finished = true;
    await drain;
  }

  const summary = clipMarked(result.reply || '', CHILD_SUMMARY_MAX) || '(无输出)';
  return {
    agentKey,
    sessionId: session.sessionId,
    summary,
    reply: result.reply ?? '',
    report: report.lastReport ?? null,
  };
}
