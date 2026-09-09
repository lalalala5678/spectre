/**
 * Backend API client for the SPECTRE console.
 *
 * All traffic goes through the auth gateway (`/spectre/api/*`); sessions
 * ride the gateway cookie. SSE subscriptions use EventSource with a
 * `since` cursor so reconnects replay missed events.
 */

export interface ApiSessionSummary {
  id: string;
  agentKey: string;

  createdAt: string;
  busy: boolean;
  messages: number;
  engagementId?: string | null;
  orchestratorSessionId?: string | null;
  workSessionId?: string | null;
  parentSessionId?: string | null;
  spawnName?: string | null;
  spawnDescription?: string | null;
  title?: string | null;
  brief?: string | null;
}

export interface ApiMessage {
  role: 'user' | 'assistant' | 'toolResult';
  ts: number;
  text: string;
  /** who injected this turn: 'user' (human) | 'agent' (DM) | 'system';
   *  absent on legacy messages — classified by text-prefix fallback */
  source?: 'user' | 'agent' | 'system';
  thinking?: string;
  toolCalls?: { id?: string; name: string; args: unknown }[];
  toolCallId?: string;
  tokens?: number;
  stopReason?: string;
  error?: string;
  isError?: boolean;
  /** client-side markers for the token-streaming bubble */
  streaming?: boolean;
  streamingThinking?: boolean;
}

export interface ApiSessionDetail {
  id: string;
  agentKey: string;
  title: string;
  createdAt: string;
  busy: boolean;
  messages: ApiMessage[];
}

export interface ApiSessionEvent {
  seq: number;
  ts: string;
  sessionId: string;
  agentKey: string;
  type: string;
  data: Record<string, unknown>;
}

export interface ApiBusEvent {
  seq: number;
  ts: string;
  channel: 'announce' | 'dm' | 'share';
  from: string;
  to: string;
  type: string;
  summary: string;
  payloadRef: string | null;
  engagement: string | null;
  severity?: string | null;
  title?: string | null;
  detail?: string | null;
  status?: string | null;
  /** revision chain: this event revises the entry with that seq */
  revises?: number | null;
  revision?: {
    n: number;
    reason: string;
    requestedBy?: { key: string; name: string; typeLabel: string } | null;
    approvedBy?: { key: string; name: string; typeLabel: string } | null;
  } | null;
  /** discoverer attribution on writer-published vulnerabilities */
  requester?: {
    key: string; name: string; typeLabel: string;
    treePath: string;
  } | null;
  author?: {
    key: string;
    name: string;
    typeLabel: string;
    parent: { key: string; name: string } | null;
    treePath: string;
    depth: number;
    sessionId: string;
  } | null;
  origin?: string | null;
  workSessionId?: string | null;
}

export const API_BASE = '/spectre/api';

export async function api<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: {
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(rest.headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  // Gateway redirects expired sessions to the login page — stop the
  // silent retry loops and send the user to re-authenticate.
  if (res.redirected && res.url.includes('/login')) {
    window.location.assign('/spectre/login');
    throw new Error('AUTH_EXPIRED');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), {
      status: res.status,
    });
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export interface Unsubscribe {
  (): void;
}

/**
 * Subscribe to an SSE endpoint with cursor-based replay.
 * `since` is captured at subscribe time; new connections replay from there.
 */
export function subscribeSse(
  path: string,
  onEvent: (eventName: string, data: unknown) => void,
  since: () => number,
): Unsubscribe {
  let source: EventSource | null = null;
  let cursor = since();
  let closed = false;

  let failures = 0;
  const authExpired = async () => {
    try {
      const res = await fetch(`${API_BASE}/health`);
      return res.redirected && res.url.includes('/login');
    } catch {
      return false;
    }
  };
  const connect = () => {
    if (closed) return;
    source = new EventSource(`${API_BASE}${path}?since=${cursor}`);
    source.onmessage = () => { /* named events only */ };
    source.addEventListener('session', () => { failures = 0; });
    source.addEventListener('bus', () => { failures = 0; });
    source.onerror = async () => {
      source?.close();
      if (closed) return;
      failures += 1;
      if (await authExpired()) {
        window.location.assign('/spectre/login');
        return;
      }
      // progressive backoff: 2s → 15s cap, reset on any live event
      const delay = Math.min(2000 * failures, 15_000);
      setTimeout(connect, delay);
    };
    const forward = (event: MessageEvent) => {
      const payload = JSON.parse(event.data as string);
      if (typeof payload.seq === 'number') cursor = payload.seq;
      onEvent(event.type, payload);
    };
    source.addEventListener('session', forward as EventListener);
    source.addEventListener('bus', forward as EventListener);
  };

  connect();
  return () => {
    closed = true;
    source?.close();
  };
}

/**
 * Revision folding — console twin of backend foldRevisions. A revision
 * is a NEW event (revises: original seq) with full replacement content;
 * the newest revision (max revision.n) is the CURRENT version. Returns
 * originals carrying `current` + `revisedCount`; standalone revisions
 * are folded away.
 */
export function foldEntries(events: ApiBusEvent[]): Array<ApiBusEvent & {
  current: ApiBusEvent;
  revisedCount: number;
}> {
  const byOriginal = new Map<number, ApiBusEvent>();
  for (const e of events) {
    if (!e.revises) continue;
    const cur = byOriginal.get(e.revises);
    if (!cur || (e.revision?.n ?? 0) >= (cur.revision?.n ?? 0)) {
      byOriginal.set(e.revises, e);
    }
  }
  const counts = new Map<number, number>();
  for (const e of events) {
    if (!e.revises) continue;
    counts.set(e.revises, Math.max(counts.get(e.revises) ?? 0, e.revision?.n ?? 0));
  }
  return events
    .filter((e): boolean => !e.revises)
    .map(e => ({ ...e, current: byOriginal.get(e.seq) ?? e,
      revisedCount: counts.get(e.seq) ?? 0 }));
}

/** Direct user edit — human is the final authority, lands immediately. */
export async function reviseEntryDirect(seq: number,
  fields: { title?: string; severity?: string; status?: string; text?: string },
  reason: string, workSessionId: string): Promise<ApiBusEvent> {
  return api<ApiBusEvent>('/bus/revise', {
    method: 'POST', json: { seq, ...fields, reason, workSessionId },
  });
}

/** Dialog revision — routes to the writer (original vuln writer or fresh). */
export async function reviseEntryViaAgent(seq: number,
  instruction: string): Promise<{ mode: string; sessionId: string }> {
  return api<{ mode: string; sessionId: string }>('/bus/revise-request', {
    method: 'POST', json: { seq, instruction },
  });
}