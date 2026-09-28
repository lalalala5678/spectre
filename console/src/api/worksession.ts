/**
 * Work-session ("大会话") — SERVER-SIDE registry. The browser keeps
 * nothing except the auth cookie: projects, the current selection and
 * per-agent remembered conversations all live on the runtime (WAL).
 * Multi-device safe; clearing browser storage loses nothing.
 */
import { api } from './client';

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
  lastSessions?: Record<string, string>;
}

interface Prefs {
  currentWs: string | null;
  ui?: { rightRatio?: number;
    stackRatios?: Record<string, number[] | null> };
}

export async function listWorkSessions(): Promise<WorkSession[]> {
  return api<WorkSession[]>('/projects');
}

export async function getPrefs(): Promise<Prefs> {
  return api<Prefs>('/prefs');
}

export async function putPrefs(patch: Partial<Prefs>): Promise<Prefs> {
  return api<Prefs>('/prefs', { method: 'PUT', json: patch });
}

/** Fire-and-forget UI pref write (panel ratios etc.). */
export async function putPrefsSync(
  patch: Partial<Prefs> & { ui?: Record<string, unknown> },
): Promise<void> {
  try { await api('/prefs', { method: 'PUT', json: patch }); }
  catch { /* UI prefs are best-effort */ }
}

export type UiPrefs = Prefs['ui'];

/** Switch the active project (server-side preference). */
export async function switchWorkSession(id: string): Promise<WorkSession | null> {
  const all = await listWorkSessions();
  const found = all.find(ws => ws.id === id) ?? null;
  if (found) await putPrefs({ currentWs: id });
  return found;
}

/** Create a user-named project and make it current. */
export async function newWorkSession(name: string): Promise<WorkSession> {
  return api<WorkSession>('/projects', { method: 'POST', json: { label: name } });
}

/**
 * Resolve the active project at boot: current pref → its project →
 * latest project → (none yet) create the first unnamed one. Also runs
 * the ONE-TIME migration: legacy browser-side registry entries are
 * uploaded verbatim (ids preserved so existing sessions stay grouped),
 * then every spectre.* storage key is wiped — the browser keeps nothing.
 */
export async function ensureWorkSession(): Promise<WorkSession> {
  await migrateLegacyStorage();
  const [prefs, all] = await Promise.all([getPrefs(), listWorkSessions()]);
  if (prefs.currentWs) {
    const found = all.find(p => p.id === prefs.currentWs);
    if (found) return found;
  }
  if (all.length > 0) return all[all.length - 1];
  return newWorkSession('');
}

let migrated = false;
async function migrateLegacyStorage() {
  if (migrated) return;
  migrated = true;
  try {
    const raw = localStorage.getItem('spectre.ws.registry');
    if (raw) {
      const legacy = JSON.parse(raw) as Array<{ id: string; label?: string }>;
      if (Array.isArray(legacy) && legacy.length) {
        await api('/projects', { method: 'POST',
          json: { projects: legacy.map(p => ({ id: p.id, label: p.label })) } });
      }
    }
  } catch { /* registry unreadable — server data wins */ }
  // Wipe every spectre.* key: browser is cookie-only now.
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('spectre.')) localStorage.removeItem(key);
  }
}

/** Remembered conversation of one agent in one project (server-side). */
export async function setLastSession(wsId: string, agentKey: string,
  sessionId: string): Promise<void> {
  await api(`/projects/${wsId}`, { method: 'PUT',
    json: { agentKey, sessionId } });
}

export async function getLastSession(wsId: string,
  agentKey: string): Promise<string | null> {
  const all = await listWorkSessions();
  return all.find(p => p.id === wsId)?.lastSessions?.[agentKey] ?? null;
}

/** F58: delete a project (server-side, WAL tombstone). */
export async function deleteWorkSession(id: string): Promise<void> {
  await api(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
