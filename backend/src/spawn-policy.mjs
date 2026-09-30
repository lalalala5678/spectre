/**
 * Dispatch-tree spawn policy (extracted F66 from agent-runtime for
 * deterministic boundary tests — behavior identical).
 *
 * Quota counts ACTIVE sessions only (Fix-C): completed = filed a
 * task report AND no run in flight. Refusals report the counting
 * basis and recovery paths (Fix-D/P3) so agents stop guessing
 * whether slots free up.
 */
import { getSpawnSettings } from './settings.mjs';

export function makeSpawnPolicy(store) {
  return {
    spawnCheck(parentRecord, _agentKey) {
      const { spawnMaxDepth, spawnMaxAgents } = getSpawnSettings();
      const rootId = store.rootIdOf(parentRecord.id);
      const childDepth = store.depthOf(parentRecord.id) + 1;
      const active = store.countTree(rootId, { activeOnly: true });
      const total = store.countTree(rootId);
      if (childDepth > spawnMaxDepth) {
        return { ok: false, reason:
          `深度上限 ${spawnMaxDepth}(当前将到第 ${childDepth} 层)`,
          depth: childDepth, active, total };
      }
      if (active + 1 > spawnMaxAgents) {
        return { ok: false, reason:
          `活跃智能体上限 ${spawnMaxAgents}(当前活跃 ${active}/历史 ${total}` +
          `——已提交任务报告的空闲会话不计入名额)。可等待在途任务完成后` +
          `重试,或经控制台调整 spawnMaxAgents。`,
          depth: childDepth, active, total };
      }
      return { ok: true, depth: childDepth, active, total };
    },

    /** Bulk quota check for dispatch_agents (Fix-B/A1): the dispatch
     *  entry point previously bypassed the quota entirely. check→start
     *  has an inherent async window (ms-scale start, s-scale session
     *  landing); overshoot is bounded by one in-flight batch and
     *  self-heals once the sessions register. */
    dispatchCheck(parentRecord, count) {
      const { spawnMaxAgents } = getSpawnSettings();
      const rootId = store.rootIdOf(parentRecord.id);
      const active = store.countTree(rootId, { activeOnly: true });
      const total = store.countTree(rootId);
      if (active + count > spawnMaxAgents) {
        return { ok: false, reason:
          `活跃智能体上限 ${spawnMaxAgents}(当前活跃 ${active}/历史 ${total}。` +
          `本批需 ${count} 个名额,超出 ${active + count - spawnMaxAgents}。` +
          `可分批派发、等待在途任务完成,或经控制台调高 spawnMaxAgents。`,
          active, total };
      }
      return { ok: true, active, total };
    },
  };
}
