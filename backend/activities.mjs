/**
 * Temporal activities — the only place workflows touch the outside world.
 *
 * LLM-driving activities are non-retryable: a retry would re-prompt the
 * agent and duplicate turns. Timeout values must stay in sync with the
 * proxyActivities options declared in workflows.mjs.
 */

import { runtime } from './src/runtime-client.mjs';

/**
 * Create a pi session bound to a stage agent. Engagement metadata marks
 * AutoPwn children (they carry report_vulnerability — the discoverer-side
 * tool; publish_vulnerability is writer-only since 14924dc, CS2-#4).
 */
export async function createSession(agentKey, opts = {}) {
  const created = await runtime.createSession(agentKey, opts);
  return { sessionId: created.id, agentKey: created.agentKey };
}

/**
 * Prompt a pi session and block until the agent produces its reply.
 * @returns {Promise<{sessionId: string, reply: string}>}
 */
export async function promptAndWait(sessionId, text) {
  // r47-D4: Temporal cancel→runtime.abortSession(pi agent.abort)——
  // 此前 activity 优雅取消不终止席位 LLM 流, 取消注入等回合自然完
  // (实测 21min 且逐轮恶化)。cancel 到达即掐流, 注入即时可入。
  let cancelFn = null;
  try {
    const { Context } = await import('@temporalio/activity');
    cancelFn = () => { try { runtime.abortSession(sessionId); } catch { /* best-effort */ } };
    Context.current().cancelled.then(cancelFn).catch(() => {});
  } catch { /* activity context 不可用(直调/测试)——维持原行为 */ }
  await runtime.prompt(sessionId, text);
  return runtime.waitIdle(sessionId);
}

/**
 * F64: the workflow nudge loop calls llm.waitIdle — the activity was
 * never exported, so any agent that missed its report crashed the
 * workflow at the first nudge (ApplicationFailure: not registered) and
 * the promised synthesized fallback report never landed (postex in
 * eng-mul1a8a5: 21-message session, zero bus events).
 * @returns {Promise<{sessionId: string, reply: string}>}
 */
export async function waitIdle(sessionId) {
  return runtime.waitIdle(sessionId);
}

/** Queue a steering message into a live pi session. */
export async function steerSession(sessionId, text) {
  return runtime.steer(sessionId, text);
}

/** Append an event to the console message bus. */
/** r6v2-#10: engagement 成员终报对账(情报库事实源)。 */
export async function engagementChildren(engagementId) {
  return runtime.engagementChildren(engagementId);
}

export async function busEmit(entry) {
  return runtime.busEmit(entry);
}

/** Task-report counter + last report meta (workflow gate reads this). */
export async function reportState(sessionId) {
  return runtime.reportState(sessionId);
}

/** Inject a follow-up into an idle session (nudge runs; steer won't fire idle). */
export async function followUpSession(sessionId, text) {
  return runtime.followUp(sessionId, text);
}

/** Mark a system-synthesized report on the runtime record so the
 *  activeOnly spawn quota releases the slot (engagement children never
 *  pass through _reportSpawnCompletion's runtime-side counter). */
export async function markReportSynthesized(sessionId, meta = {}) {
  return runtime.markReportSynthesized(sessionId, meta);
}

/** r29b-残留②: 送达时对账段构造(纯函数, 注入式自测面)。 */
export function buildLateRecon(recheck, children, clock = () => new Date()) {
  const parts = (Array.isArray(recheck) ? recheck : [])
    .map(k => children[k]
      ? `${k}: 终报已落账(${children[k].status ?? '?'})《${String(children[k].title ?? '').slice(0, 50)}》(seq=${children[k].seq})${children[k].crossEngagement ? `[补位/重派席位, 报告挂其原战役 ${children[k].crossEngagement}]` : ''}——勿判失败`
      : `${k}: 快照时点库内仍无终报(投递后落账未覆盖——终局以 query_intel 为准)`)
    .map(x => `- ${x}`);
  if (!parts.length) return '';
  return `\n[排空对账·${clock().toISOString().slice(11, 19)}(投递前快照; 终局以 query_intel 为准)]\n${parts.join('\n')}`;
}

/** Notify the orchestrator session that its engagement finished. */
export async function notifyEngagementDone({ orchestratorSessionId,
                                             engagementId, summary, recheck = [] }) {
  if (!orchestratorSessionId) {
    return { skipped: true };
  }
  // r6v3-#10: 送达时对账——workflow 判死与终报落账存在时序窗, 构建时
  // 快照可能恒旧。投递前对 error 成员重查情报库, 追加终局状态。
  // r29b-残留②: 纯函数化(buildLateRecon)供注入式自测——竞态难实战
  // 摆拍, 单测正样本(构建后落账→勿判失败/未覆盖→以库为准)。
  let lateRecon = '';
  if (Array.isArray(recheck) && recheck.length) {
    try {
      lateRecon = buildLateRecon(recheck, await runtime.engagementChildren(engagementId));
    } catch { /* 对账尽力——不影响通知本体 */ }
  }
  return runtime.followUp(
    orchestratorSessionId,
    `[engagement ${engagementId} 完成] 全部子智能体产出:\n${summary}${lateRecon}\n` +
    '请向用户汇总本次结果(重点、风险、建议)。',
  );
}
