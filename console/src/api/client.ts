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
  void?: boolean | null;
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
      ...(json !== undefined && { 'Content-Type': 'application/json' }),
      ...(rest.headers),
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
    // R32D35-E1: 非 JSON 错误体的回退文案中文化(此前 'HTTP 502')
    throw Object.assign(new Error(body.error ?? `请求失败(HTTP ${res.status})`), {
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
/** R14-F3: 认证过期探测——从 subscribeSse 闭包提升为共享(双胞胎纪律)。
 * Gateway 把过期会话重定向到登录页, 必须停掉静默退避循环送用户重登。 */
async function authExpired(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`);
    return res.redirected && res.url.includes('/login');
  } catch {
    return false;
  }
}

// F52: bus/events 共享单例——此前每个面板(Vuln/Intel/TaskReports/
// EntryDetail/BusView)各开一条 SSE,同一工作区 4-5 连接;页面切换
// 叠加曾把浏览器并发连接池耗尽(ERR_INSUFFICIENT_RESOURCES ×1090,
// 全量 UI 实测)。引用计数: 首订阅者建立,末订阅者关闭。
type BusHandler = (eventName: string, data: unknown) => void;
const busSubs = new Set<BusHandler>();
let busSource: EventSource | null = null;
let busCursor = 0;
let busFailures = 0;

function busConnect() {
  if (busSource || busSubs.size === 0) return;
  busSource = new EventSource(`${API_BASE}/bus/events?since=${busCursor}`);
  busSource.addEventListener('bus', (ev: MessageEvent) => {
    busFailures = 0;
    try {
      const payload = JSON.parse(ev.data as string);
      if (typeof payload.seq === 'number') busCursor = payload.seq;
      for (const h of busSubs) h('bus', payload);
    } catch { /* malformed */ }
  });
  busSource.onerror = async () => {
    busSource?.close();
    busSource = null;
    // R14-F3: 与 subscribeSse 同款探测——过期后六面板静默退避死循环
    if (await authExpired()) {
      window.location.assign('/spectre/login');
      return;
    }
    if (busSubs.size > 0) {
      const delay = Math.min(2000 * ++busFailures, 15_000);
      setTimeout(busConnect, delay);
    }
  };
}

export function subscribeBus(onEvent: BusHandler): Unsubscribe {
  busSubs.add(onEvent);
  busConnect();
  return () => {
    busSubs.delete(onEvent);
    if (busSubs.size === 0) {
      busSource?.close();
      busSource = null;
    }
  };
}

export function subscribeSse(
  path: string,
  onEvent: (eventName: string, data: unknown) => void,
  since: () => number,
): Unsubscribe {
  let source: EventSource | null = null;
  let cursor = since();
  let closed = false;

  let failures = 0;

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
/** 修订折叠后的总线条目(现行版 current + 修订计数)。 */
export type FoldedEntry = ApiBusEvent & {
  current: ApiBusEvent;
  revisedCount: number;
  orphaned?: boolean;
};

export function foldEntries(events: ApiBusEvent[]): FoldedEntry[] {
  const byOriginal = new Map<number, ApiBusEvent>();
  const counts = new Map<number, number>();
  const known = new Set(events.filter(e => !e.revises).map(e => e.seq));
  for (const e of events) {
    if (!e.revises) continue;
    const cur = byOriginal.get(e.revises);
    if (!cur || (e.revision?.n ?? 0) >= (cur.revision?.n ?? 0)) {
      byOriginal.set(e.revises, e);
    }
    counts.set(e.revises, Math.max(counts.get(e.revises) ?? 0, e.revision?.n ?? 0));
  }
  const out: Array<ApiBusEvent & { current: ApiBusEvent; revisedCount: number; orphaned?: boolean }> = [];
  const orphans = new Set<number>();
  for (const e of events) {
    if (!e.revises) {
      out.push({ ...e, current: byOriginal.get(e.seq) ?? e,
        revisedCount: counts.get(e.seq) ?? 0 });
    } else if (!known.has(e.revises) && !orphans.has(e.revises)) {
      // original trimmed past the bus journal — surface standalone
      // R2-F2: current=最新修订(n 最大), 双胞胎对齐 revision.mjs
      orphans.add(e.revises);
      const newest = byOriginal.get(e.revises) ?? e;
      out.push({ ...newest, current: newest,
        revisedCount: counts.get(e.revises) ?? 0, orphaned: true });
    }
  }
  return out;
}

/** Direct user edit — human is the final authority, lands immediately. */
export async function reviseEntryDirect(seq: number,
  fields: { title?: string; severity?: string; status?: string; text?: string },
  reason: string, workSessionId: string | null): Promise<ApiBusEvent> {
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