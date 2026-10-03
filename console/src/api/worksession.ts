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
    stackRatios?: Record<string, number[] | null>;
    splitRatios?: Record<string, number | null>;  // EQ-8: SplitPane 宽度持久化
  };
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


/** Switch the active project (server-side preference). */
export async function switchWorkSession(id: string): Promise<WorkSession | null> {
  const all = await listWorkSessions();
  const found = all.find(ws => ws.id === id) ?? null;
  if (found) await putPrefs({ currentWs: id });
  return found;
}

/** Create a user-named project and make it current. */
export async function newWorkSession(name: string): Promise<WorkSession> {
  // R32D31-N1: activate=true 显式切换活跃项目(保持内联新建原体验);
  // API/CLI 裸调不再劫持控制台 currentWs。
  return api<WorkSession>('/projects', { method: 'POST', json: { label: name, activate: true } });
}

/**
 * Resolve the active project at boot: current pref → its project →
 * latest project → (none yet) create the first unnamed one. Also runs
 * the ONE-TIME migration: legacy browser-side registry entries are
 * uploaded with same-domain id validation (CS47-N6)
 * then every spectre.* storage key is wiped — the browser keeps nothing.
 */
// F1(十五轮): 本体也 memo——R14-F2 只 memo 了 migration; 全新用户无
// legacy 键时迁移是空操作, AgentWorkspacePage 两处 boot 并发调用仍
// 同时看到空表→各自 POST /projects 产出双「未命名项目」。并发者
// await 同一 ensure promise, 落后者复用首建结果。
let ensuring: Promise<WorkSession> | null = null;
export function ensureWorkSession(): Promise<WorkSession> {
  return ensuring ??= (async () => {
    try {
      await migrateLegacyStorage();
      const [prefs, all] = await Promise.all([getPrefs(), listWorkSessions()]);
      if (prefs.currentWs) {
        const found = all.find(p => p.id === prefs.currentWs);
        if (found) return found;
      }
      if (all.length > 0) {
        // R32D42-P2: 回退分支写回 currentWs——此前 agent 页静默用最新
        // 项目而 skills/mcp/cli/reports 读 prefs 显示「无当前项目」,
        // 同一控制台双口径(需手动重点项目才一致)。
        const fallback = all[all.length - 1];
        try { await putPrefs({ currentWs: fallback.id }); } catch { /* 后端不可达时保持本地一致 */ }
        return fallback;
      }
      return await newWorkSession('');
    } finally {
      ensuring = null;  // 失败后允许重试(不缓存错误态)
    }
  })();
}

// R14-F2: memoized promise——migrated 布尔在 await 前置位, 并发
// ensureWorkSession(StrictMode 双挂载确定性触发)在上传在途时即看
// 到空表, 各自建'未命名项目'。并发者 await 同一 promise, 落后者
// 的列表必在上传落地之后。
let migration: Promise<void> | null = null;
function migrateLegacyStorage(): Promise<void> {
  return migration ??= (async () => {
    const raw = localStorage.getItem('spectre.ws.registry');
    if (!raw) {
      wipeSpectreKeys();
      return;
    }
    let legacy: Array<{ id: string; label?: string }>;
    try {
      legacy = JSON.parse(raw) as Array<{ id: string; label?: string }>;
    } catch {
      // registry unreadable — server data wins(无可救数据, wipe 合理)
      wipeSpectreKeys();
      return;
    }
    if (Array.isArray(legacy) && legacy.length) {
      try {
        // R14-F1: 上传失败(网络/5xx/auth 过期)不 wipe——键保留待下次
        // boot 重试(服务端 !getProject 守卫保证幂等); 此前落同一
        // catch 后无条件清除, 遗留注册表不可逆丢失。
        await api('/projects', { method: 'POST',
          json: { projects: legacy.map(p => ({ id: p.id, label: p.label })) } });
      } catch {
        return;  // 保留 spectre.* 键重试
      }
    }
    wipeSpectreKeys();
  })();
}

function wipeSpectreKeys() {
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


/** F58: delete a project (server-side, WAL tombstone). */
export async function deleteWorkSession(id: string): Promise<void> {
  await api(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
