/**
 * Server-side project registry + user prefs — the browser keeps NOTHING
 * except the auth cookie (single source of truth; multi-device safe).
 *
 * Persistence: the WAL (entry kinds 'proj' and 'pref') — same
 * append-only channel as sessions and bus. Projects are tiny.
 *
 * Project record: { id, label, createdAt, lastSessions: {agentKey: sessionId} }
 * Prefs record:   { currentWs, ui: { rightRatio, stackRatios },
 *                   commonSettings, reconApiKeys, bruteParams }
 */

let projects = new Map();   // id → project
let prefs = { currentWs: null, ui: {} };

const tombstones = new Set();  // R9-F5: 已删项目墓碑——迟到的会话变更不得复活

export function projectsFromWal(entries) {
  for (const e of entries) {
    if (e.t === 'proj' && e.d?.id) { projects.set(e.d.id, e.d); tombstones.delete(e.d.id); }
    if (e.t === 'proj-del' && e.d?.id) { projects.delete(e.d.id); tombstones.add(e.d.id); }
    if (e.t === 'pref' && e.d) prefs = { ...prefs, ...e.d };
  }
}

/** R9-F5: 项目是否已被删除(墓碑)。已删 id 不经 ensureProject 复活
 * (F58 '从每个列表消失'不变量); 从未见过的 id 照常零摩擦自动建。 */
export function isTombstoned(id) {
  return tombstones.has(id);
}

/** R9-F5: 全部墓碑 id——compact 重写时保留 proj-del(R9 调试发现:
 * compact 只写活项目, 墓碑不过 compaction 则重启丢失)。 */
export function tombstonesAll() {
  return [...tombstones];
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
  tombstones.delete(id);  // R9-F5: 显式创建/重建清墓碑
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

/** F58: project deletion. WAL tombstone (proj-del) keeps the replay
 *  deterministic; sessions of the project are kept (history) but the
 *  project disappears from every list. Deleting the CURRENT project
 *  clears the preference (caller responsibility to pick a next one). */
export function deleteProject(id, wal) {
  if (!projects.has(id)) return false;
  projects.delete(id);
  tombstones.add(id);  // R9-F5
  wal?.append({ t: 'proj-del', d: { id } });
  if (prefs.currentWs === id) {
    prefs.currentWs = null;
    // R9-F1: 内存变更必须先 durable——不落盘则非优雅退出后重放出
    // 悬空 currentWs, 且 boot compact 以 getPrefs() 快照永久固化。
    wal?.append({ t: 'pref', d: prefs });
  }
  return true;
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


// ------------------------------ prefs ------------------------------

export function getPrefs() {
  return { ...prefs, ui: { ...prefs.ui } };
}

export function setPrefs(patch, wal) {
  const ui = { ...prefs.ui, ...patch.ui };
  // R13-F4: stackRatios 按 key 合并——ui 级浅合并此前使单 key patch
  // 整体替换 stackRatios(auto 页拖动抹掉 stage 页已存比例, 违
  // PanelStack 'per storage key' 持久化契约)。null 值按 key 清除
  // (evenSplit 语义保留)。
  if (patch.ui?.stackRatios) {
    ui.stackRatios = { ...prefs.ui?.stackRatios };
    for (const [k, v] of Object.entries(patch.ui.stackRatios)) {
      if (v === null) delete ui.stackRatios[k];
      else ui.stackRatios[k] = v;
    }
  }
  prefs = { ...prefs, ...patch, ui };
  wal?.append({ t: 'pref', d: prefs });
  return getPrefs();
}
