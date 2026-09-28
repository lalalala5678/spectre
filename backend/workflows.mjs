/**
 * SPECTRE orchestration workflows.
 *
 * autoPwnWorkflow (parent)
 *   - announces the engagement (公告) and dispatches one agentTaskWorkflow
 *     child per selected stage agent (私信 dispatch)
 *   - message policy (per product decision):
 *       · child → orchestrator: publish_vulnerability/publish_intel tool → bus 私信
 *         + followUp into the orchestrator pi session (LLM decides relays)
 *       · orchestrator → children: relay_to_agents tool → orchestratorRelay
 *         signal → targeted dm into child pi sessions
 *       · child ↔ child: never direct; shares journal on the bus (共享) but
 *         are NOT auto-fan-out — relaying is the orchestrator's call
 *       · broadcast signal → fan out to all children (公告)
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

const signals = {
  agentShare: defineSignal('agentShare'),
  agentResult: defineSignal('agentResult'),
  broadcast: defineSignal('broadcast'),
  dm: defineSignal('dm'),
  orchestratorRelay: defineSignal('orchestratorRelay'),
  agentMessage: defineSignal('agentMessage'),
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
function clipMarked(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}[已截断:原文 ${text.length} 字符]`;
}

/**
 * Per-child digest cap in the engagement-done DM. Real replies run 0.5-1.3k
 * chars (project-3 test: 473/635/1284-char originals all clipped at the old
 * 200 cap); 2000 keeps normal replies whole while the whole notice stays far
 * below the 32k prompt cap even for several children.
 */
const CHILD_SUMMARY_MAX = 2000;


/**
 * Report nudge text — twin constant lives in sessions.mjs (architecture
 * rule: workflows must not import runtime modules).
 */
const REPORT_NUDGE_TEXT = '【系统要求】本段运行尚未提交任务报告。请立即调用 ' +
  'submit_task_report(必需字段:title/status/task/actions/outcome),说明做了什么、' +
  '结果或失败原因与全部必要信息——即使没有任何发现也必须提交。这是结束任务的必要条件;' +
  '提交后本任务即告完成。';
/**
 * @param {{engagementId: string, instruction: string, agents: string[],
 *          orchestratorSessionId?: string|null}} input
 */
export async function autoPwnWorkflow(input) {
  const { engagementId, instruction, agents, orchestratorSessionId,
          workSessionId } = input;
  const engagement = `autopwn-${engagementId}`;
  const children = new Map();     // agentKey -> child handle
  const inbox = [];               // {kind, from, to, text, summary, payloadRef}
  const publishedVulns = new Set();  // agentKeys that emitted intel
  let open = true;

  setHandler(signals.agentShare, (msg) => {
    inbox.push({ kind: 'share', ...msg });
  });
  setHandler(signals.agentResult, (msg) => {
    inbox.push({ kind: 'result', ...msg });
  });
  setHandler(signals.broadcast, (msg) => {
    inbox.push({ kind: 'broadcast', ...msg });
  });
  setHandler(signals.orchestratorRelay, (msg) => {
    inbox.push({ kind: 'relay', from: 'orchestrator', ...msg });
  });
  // child → orchestrator intel: bus journal + followUp happen runtime-side
  // (the tool); the signal also marks the child so its completion share is
  // skipped — the vuln/intel events already represent that output (prevents
  // the "two entries for one request" duplication).
  setHandler(signals.agentMessage, (msg) => {
    publishedVulns.add(msg.from);
  });

  // Single drain task: journal events + route dms per policy above.
  const drain = (async () => {
    while (open || inbox.length > 0) {
      await condition(() => inbox.length > 0 || !open);
      if (inbox.length === 0) break;
      const msg = inbox.shift();
      if (msg.kind === 'share') {
        await quick.busEmit({
          channel: 'share', from: msg.from, type: 'handoff',
          summary: `情报共享:${msg.summary}`,
          payloadRef: msg.payloadRef ?? null, engagement,
          workSessionId,
        });
      } else if (msg.kind === 'result') {
        await quick.busEmit({
          channel: 'dm', from: msg.from, to: 'orchestrator', type: 'result',
          summary: `任务完成:${msg.summary}`, engagement,
          workSessionId,
        });
      } else if (msg.kind === 'broadcast') {
        await quick.busEmit({
          channel: 'announce', from: msg.from || 'user', type: 'context',
          summary: msg.text, engagement,
          workSessionId,
        });
        for (const [, handle] of children) {
          await handle.signal(signals.dm, { from: 'orchestrator', text: msg.text });
        }
      } else if (msg.kind === 'relay') {
        for (const key of msg.to ?? []) {
          const handle = children.get(key);
          if (handle) {
            await handle.signal(signals.dm, { from: 'orchestrator', text: msg.text });
          }
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
  await Promise.all(agents.map(async (agentKey) => {
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
    try {
      const result = await handle.result();
      results.set(agentKey, result);
      if (!publishedVulns.has(agentKey)) {
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
    summary: `公告:全部 ${agents.length} 个智能体任务结束,engagement ${engagementId} 关闭。`,
    engagement, workSessionId,
  });

  // Q2(a): completion notice auto-injected into the orchestrator session.
  const summaryLines = [...results.entries()]
    .map(([key, value]) => {
      if (value.report) {
        return `- ${key}: 任务报告已入库(${value.report.status})《${clipMarked(value.report.title, 60)}》—详情用 query_intel 读取`;
      }
      return `- ${key}: ${clipMarked(value.summary ?? value.error ?? '', CHILD_SUMMARY_MAX)}`;
    })
    .join('\n');
  await quick.notifyEngagementDone({
    orchestratorSessionId,
    engagementId,
    summary: summaryLines,
  });

  return {
    engagementId,
    agents: [...results.entries()].map(([key, value]) => ({ agentKey: key, ...value })),
  };
}

/**
 * @param {{agentKey: string, engagementId: string, instruction: string,
 *          orchestratorSessionId?: string|null}} input
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
  let finished = false;
  setHandler(signals.dm, (msg) => {
    inbox.push(msg);
  });

  // Steer incoming orchestrator dms into the live pi session while it works.
  const drain = (async () => {
    while (!finished) {
      await condition(() => inbox.length > 0 || finished);
      if (finished) break;
      const msg = inbox.shift();
      if (msg) {
        await llm.steerSession(session.sessionId, `[DM from ${msg.from}] ${msg.text}`);
      }
    }
  })();

  let result;
  let report;
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
    // Task-report gate: a task may only finish with a report on file.
    // Nudge ≤2 (followUp fires an idle agent; steer would only queue),
    // then synthesize from the final reply so readers never see a hole.
    for (let nudge = 0; nudge < 2; nudge++) {
      report = await quick.reportState(session.sessionId);
      if (report.count > base.count) break;
      await quick.followUpSession(session.sessionId, REPORT_NUDGE_TEXT);
      result = await llm.waitIdle(session.sessionId);
    }
    report = await quick.reportState(session.sessionId);
    if (report.count <= base.count) {
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
