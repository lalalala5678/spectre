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
 * AutoPwn children (they carry the publish_vulnerability tool).
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
  await runtime.prompt(sessionId, text);
  return runtime.waitIdle(sessionId);
}

/** Queue a steering message into a live pi session. */
export async function steerSession(sessionId, text) {
  return runtime.steer(sessionId, text);
}

/** Append an event to the console message bus. */
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

/** Notify the orchestrator session that its engagement finished. */
export async function notifyEngagementDone({ orchestratorSessionId,
                                             engagementId, summary }) {
  if (!orchestratorSessionId) {
    return { skipped: true };
  }
  return runtime.followUp(
    orchestratorSessionId,
    `[engagement ${engagementId} 完成] 全部子智能体产出:\n${summary}\n` +
    '请向用户汇总本次结果(重点、风险、建议)。',
  );
}
