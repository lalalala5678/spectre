/**
 * Typed HTTP client for the agent runtime, used by Temporal activities.
 *
 * Every call carries the internal token; agent-impersonating routes reject
 * anything without it. Timeouts are generous for LLM-bound operations.
 */

import { CONFIG } from './config.mjs';

const BASE = `http://127.0.0.1:${CONFIG.port}`;

class RuntimeError extends Error {
  constructor(status, body) {
    super(`runtime ${status}: ${body?.error ?? 'request failed'}`);
    this.status = status;
  }
}

async function call(method, path, body, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': CONFIG.internalToken,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new RuntimeError(res.status, data);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export const runtime = {
  createSession: (agentKey, opts = {}) =>
    call('POST', '/api/sessions', { agentKey, ...opts }),

  followUp: (sessionId, text) =>
    call('POST', `/api/sessions/${sessionId}/followup`, { text }),

  prompt: (sessionId, text) =>
    call('POST', `/api/sessions/${sessionId}/messages`, { text, source: 'agent' }),

  steer: (sessionId, text) =>
    call('POST', `/api/sessions/${sessionId}/steer`, { text, source: 'agent' }),

  /** Waits for the agent to finish; long timeout for reasoning models. */
  waitIdle: (sessionId) =>
    call('POST', `/api/sessions/${sessionId}/wait-idle`, undefined,
      CONFIG.maxIdleWaitMs + 10_000),

  busEmit: (entry) =>
    call('POST', '/api/bus', entry),

  /** Task-report counter + last report meta (workflow gate reads this). */
  reportState: (sessionId) =>
    call('GET', `/api/sessions/${sessionId}/report-state`),
};
