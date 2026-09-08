/**
 * Work-session ("大会话") registry — client-side grouping key.
 *
 * One work session is a task container (任务一/任务二…). Inside it, every
 * agent owns its own numbered conversations (会话一/会话二…); numbering is
 * per (work session, agent) and fully independent across agents. The
 * current selection survives navigation and reloads via localStorage.
 */

const CURRENT_KEY = 'spectre.ws.current';
const REGISTRY_KEY = 'spectre.ws.registry';

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

export function cnNumber(n: number): string {
  if (n <= 0 || !Number.isInteger(n)) return String(n);
  if (n < 10) return CN_DIGITS[n];
  if (n < 20) return `十${n % 10 ? CN_DIGITS[n % 10] : ''}`;
  if (n < 100) {
    return `${CN_DIGITS[Math.floor(n / 10)]}十${n % 10 ? CN_DIGITS[n % 10] : ''}`;
  }
  return String(n);
}

export interface WorkSession {
  id: string;
  label: string;
  createdAt: string;
}

function readRegistry(): WorkSession[] {
  try {
    return JSON.parse(localStorage.getItem(REGISTRY_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function writeRegistry(entries: WorkSession[]) {
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(entries));
}

/**
 * The active work session, creating the first one (unnamed fallback) when
 * none exists. Projects are always user-named on creation — see
 * newWorkSession(name).
 */
export function ensureWorkSession(): WorkSession {
  const id = localStorage.getItem(CURRENT_KEY);
  const registry = readRegistry();
  if (id) {
    const found = registry.find(ws => ws.id === id);
    if (found) return found;
  }
  const created = makeWorkSession('');
  writeRegistry([...registry, created]);
  localStorage.setItem(CURRENT_KEY, created.id);
  return created;
}

function makeWorkSession(name: string): WorkSession {
  return {
    id: `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label: name.trim() || '未命名项目',
    createdAt: new Date().toISOString(),
  };
}

export function listWorkSessions(): WorkSession[] {
  return readRegistry();
}

export function switchWorkSession(id: string): WorkSession | null {
  const found = readRegistry().find(ws => ws.id === id);
  if (found) localStorage.setItem(CURRENT_KEY, id);
  return found ?? null;
}

/** Create a user-named project and make it current. */
export function newWorkSession(name: string): WorkSession {
  const registry = readRegistry();
  const created = makeWorkSession(name);
  writeRegistry([...registry, created]);
  localStorage.setItem(CURRENT_KEY, created.id);
  return created;
}

/** localStorage slot for the active conversation of one agent in one work session. */
export const smallSessionSlot = (wsId: string, agentKey: string) =>
  `spectre.session.${wsId}.${agentKey}`;
