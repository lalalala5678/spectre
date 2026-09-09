/**
 * Session-time sandbox mounting — synchronous assembly with async
 * caches, so the synchronous `_buildAgent` gets the full picture:
 *
 *   sync  : ExecutionEnv per (driver, project) — pure object, cheap
 *           official bash/read/write/edit bound to that env
 *           MCP tools from the per-agent snapshot cache
 *           skill index from the per-agent cache
 *   async : cache rebuilds (server start, config change, first boot) —
 *           "snapshot at session creation" semantics preserved.
 */
import { makeExecutionEnv, ensureWorkspaceSync, CONTAINER } from './exec-env.mjs';
import { buildOfficialTools } from './harness-adapter.mjs';
import { mcpToolsFor, loadMcpConfig } from './mcp.mjs';
import { refreshSkillMounts, skillsFor } from './skills.mjs';
import { sandboxConfig } from './container.mjs';

let skillIndexCache = new Map();  // agentKey → Skill[]
const mcpToolCache = new Map();   // agentKey → pi-tool[]

/** Warm every cache (boot / config change). Safe to re-run. */
export async function rebuildMounts(agentKeys) {
  const cfg = sandboxConfig();
  skillIndexCache = await refreshSkillMounts(agentKeys, cfg);
  await loadMcpConfig();
  for (const key of agentKeys) {
    // failures degrade to no-tools (mcpToolsFor already warns), never block
    mcpToolCache.set(key, await mcpToolsFor(key));
  }
  return { agents: agentKeys.length };
}

export function mcpToolsCached(agentKey) {
  return mcpToolCache.get(agentKey) ?? [];
}

export function skillsCached(agentKey) {
  return skillIndexCache.get(agentKey) ?? [];
}

/**
 * Sync assembly for one session: env + official tools + cached MCP tools
 * + cached skill index. `wsId` drives the project working directory.
 */
export function mountForSession(agentKey, wsId) {
  const cfg = sandboxConfig();
  const workspace = wsId ?? '_default';
  ensureWorkspaceSync(workspace);
  const env = makeExecutionEnv(cfg, workspace);
  return {
    env,
    tools: [...buildOfficialTools(env), ...mcpToolsCached(agentKey)],
    workspaceDir: `${CONTAINER.workspace}/${workspace}`,
  };
}
