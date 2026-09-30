/**
 * Runtime-editable spawn policy (dispatch-tree limits).
 *
 * Enforced server-side; the console's 配置 tab is just one editor.
 * 持久化: WAL 'spawn' 条目(F68)——重启恢复, 非内存态(CS3-N10 纠偏
 * 旧注释)。
 */

const DEFAULTS = Object.freeze({
  spawnMaxDepth: 3,   // root orchestrator = depth 0; spawned levels ≤ this
  spawnMaxAgents: 8,  // max sessions per dispatch tree (root included)
});

let settings = { ...DEFAULTS };

/** F68: WAL replay — spawn policy used to be memory-only (dev-phase
 *  note admitted it), losing user edits on every restart (5/12 → 3/8
 *  on reboot, live-verified). Same pattern as prefs (t:'spawn'). */
export function spawnSettingsFromWal(entries) {
  for (const e of entries) {
    if (e.t === 'spawn' && e.d && Number.isFinite(Number(e.d.spawnMaxDepth))) {
      settings = {
        spawnMaxDepth: Math.min(Math.max(1, Number(e.d.spawnMaxDepth)), 10),
        spawnMaxAgents: Math.min(Math.max(1, Number(e.d.spawnMaxAgents ?? DEFAULTS.spawnMaxAgents)), 64),
      };
    }
  }
}

export function getSpawnSettings() {
  return { ...settings };
}

export function setSpawnSettings(patch = {}, wal = null) {
  const depth = Number(patch.spawnMaxDepth);
  const count = Number(patch.spawnMaxAgents);
  settings = {
    spawnMaxDepth: Number.isFinite(depth) && depth >= 1
      ? Math.min(depth, 10) : DEFAULTS.spawnMaxDepth,
    spawnMaxAgents: Number.isFinite(count) && count >= 1
      ? Math.min(count, 64) : DEFAULTS.spawnMaxAgents,
  };
  wal?.append({ t: 'spawn', d: { ...settings } });
  return getSpawnSettings();
}
