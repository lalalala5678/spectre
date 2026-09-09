/**
 * Server-side project registry + user prefs — the browser keeps NOTHING
 * except the auth cookie (single source of truth; multi-device safe).
 *
 * Persistence: the WAL (entry kinds 'proj' and 'pref') — same
 * append-only channel as sessions and bus. Projects are tiny.
 *
 * Project record: { id, label, createdAt, lastSessions: {agentKey: sessionId} }
 * Prefs record:   { currentWs, ui: { rightRatio, stackRatios } }
 */
import { Wal } from './persist.mjs';

let projects = new Map();   // id → project
let prefs = { currentWs: null, ui: {} };

export function projectsFromWal(entries) {
  for (const e of entries) {
    if (e.t === 'proj' && e.d?.id) projects.set(e.d.id, e.d);
    if (e.t === 'pref' && e.d) prefs = { ...prefs, ...e.d };
  }
}

export function listProjects() {
  return [...projects.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getProject(id) {
  return projects.get(id) ?? null;
}

/** Auto-register an unknown ws id (sessions may arrive before the console
 *  ever created the project — zero-friction onboarding). */
export function ensureProject(id, wal, label) {
  if (!id) return null;
  let p = projects.get(id);
  if (p) return p;
  p = { id, label: label ?? '未命名项目', createdAt: new Date().toISOString(),
    lastSessions: {} };
  projects.set(id, p);
  wal?.append({ t: 'proj', d: p });
  return p;
}

export function renameProject(id, label, wal) {
  const p = projects.get(id);
  if (!p) return null;
  p.label = String(label ?? '').slice(0, 60) || p.label;
  wal?.append({ t: 'proj', d: p });
  return p;
}

export function createProject(label, wal, id) {
  const pid = id ?? `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const p = { id: pid, label: String(label ?? '').trim().slice(0, 60) || '未命名项目',
    createdAt: new Date().toISOString(), lastSessions: {} };
  projects.set(pid, p);
  wal?.append({ t: 'proj', d: p });
  return p;
}

/** Remembered conversation per (project, agent) — was browser
 *  localStorage smallSessionSlot, now server-side. */
export function setLastSession(id, agentKey, sessionId, wal) {
  const p = projects.get(id);
  if (!p || !agentKey || !sessionId) return;
  p.lastSessions[agentKey] = sessionId;
  wal?.append({ t: 'proj', d: p });
}

export function getLastSession(id, agentKey) {
  return projects.get(id)?.lastSessions?.[agentKey] ?? null;
}

// ------------------------------ prefs ------------------------------

export function getPrefs() {
  return { ...prefs, ui: { ...prefs.ui } };
}

export function setPrefs(patch, wal) {
  prefs = { ...prefs, ...patch, ui: { ...prefs.ui, ...(patch.ui ?? {}) } };
  wal?.append({ t: 'pref', d: prefs });
  return getPrefs();
}
