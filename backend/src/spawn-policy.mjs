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
          `深度上限 ${spawnMaxDepth}(根=L0,最深允许第 ${spawnMaxDepth} 层;当前将到第 ${childDepth} 层被拒)`,
          depth: childDepth, active, total, spawnMaxDepth };  // r26②: 成功回执带实值
      }
      if (active + 1 > spawnMaxAgents) {
        // r12-UX: 拒绝文案列名计数构成(观察项采纳——树根计入系反推
        // 而非明示的怨念)
        const names = (store.treeActiveAgents?.(rootId) ?? []).join('、');
        return { ok: false, reason:
          `活跃智能体上限 ${spawnMaxAgents}(当前活跃 ${active}/历史 ${total}` +
          `——已提交任务报告的空闲会话不计入名额)。` +
          (names ? `当前活跃构成:${names}(含树根本身)。` : '') +
          `可等待在途任务完成后重试,或经控制台调整 spawnMaxAgents。`,
          depth: childDepth, active, total, spawnMaxDepth };  // r26②: 成功回执带实值
      }
      return { ok: true, depth: childDepth, active, total, spawnMaxDepth };  // r26②: 成功回执带实值
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
        const names = (store.treeActiveAgents?.(rootId) ?? []).join('、');
        return { ok: false, reason:
          `活跃智能体上限 ${spawnMaxAgents}(当前活跃 ${active}/历史 ${total}。` +
          `本批需 ${count} 个名额,超出 ${active + count - spawnMaxAgents}。` +
          (names ? `当前活跃构成:${names}(含树本身)。` : '') +
          `可分批派发、等待在途任务完成,或经控制台调高 spawnMaxAgents。`,
          active, total };
      }
      // r42-F-G: 同项目多主控并发警告闸——另一 busy 主控会话在指挥时
      // 各自 ≤7 滚动波会叠加(实测 12-15 并发致 429 五连杀)。软警告
      // 不拒(多主控合法场景存在), 单飞纪律由编排侧执行。
      const wsId = parentRecord.workSessionId ?? null;
      if (wsId) {
        const others = [...store.sessions.values()].filter(x =>
          x.agentKey === 'autopwn' && x.id !== parentRecord.id && x.busy
          && (x.workSessionId ?? null) === wsId);
        if (others.length) {
          return { ok: true, active, total, warn:
            `⚠ 单飞警告: 本项目另有 ${others.length} 个主控会话正在忙碌运行` +
            `(${others.map(x => x.spawnName ?? x.rawTitle ?? x.id.slice(0, 12)).slice(0, 3).join('、')})——` +
            `双主控并发派发会叠加席位并发(实测曾 429 五连杀)。` +
            `除非确系有意并行, 请先等它收口(单飞纪律), 或 relay 协调后由单方派发。` };
        }
      }
      return { ok: true, active, total };
    },
  };
}
