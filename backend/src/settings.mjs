/**
 * Runtime-editable spawn policy (dispatch-tree limits).
 *
 * Enforced server-side; the console's 配置 tab is just one editor. Values
 * live in memory (dev-phase persistence note in ARCHITECTURE §7).
 */

const DEFAULTS = Object.freeze({
  spawnMaxDepth: 3,   // root orchestrator = depth 0; spawned levels ≤ this
  spawnMaxAgents: 8,  // max sessions per dispatch tree (root included)
});

let settings = { ...DEFAULTS };

export function getSpawnSettings() {
  return { ...settings };
}

export function setSpawnSettings(patch = {}) {
  const depth = Number(patch.spawnMaxDepth);
  const count = Number(patch.spawnMaxAgents);
  settings = {
    spawnMaxDepth: Number.isFinite(depth) && depth >= 1
      ? Math.min(depth, 10) : DEFAULTS.spawnMaxDepth,
    spawnMaxAgents: Number.isFinite(count) && count >= 1
      ? Math.min(count, 64) : DEFAULTS.spawnMaxAgents,
  };
  return getSpawnSettings();
}
