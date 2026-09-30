/**
 * applyMcpAndMounts (CS1-R8): routes/tooling 里"改配置 → 失效连接 →
 * 重建挂载"组合的收敛入口。九处调用的顺序差异在这里固化并注释:
 *
 * - POST /api/sandbox/mcp(同名更新): close → mutate → rebuild
 *   (R5-F2: 旧连接不失效则新 command/env 永不生效)
 * - DELETE /api/sandbox/mcp: mutate → close → rebuild
 * - skills CRUD / config 恢复: (save/delete 已完成) → rebuild
 *
 * @param {{mutate?: (list: Array) => Array, closeName?: string,
 *          closeFirst?: boolean}} [o] closeFirst=true 时先失效连接
 * (同名更新语义), 否则 mutate 后失效(删除语义)。
 * @returns {Promise<Array|void>} mutate 后的配置列表(未 mutate 时 void)
 */
import { AGENT_KEYS } from '../agents.mjs';
import { mutateMcpConfig, closeMcpConnection } from './mcp.mjs';
import { rebuildMounts } from './mount.mjs';

export async function applyMcpAndMounts(o = {}) {
  let next;
  if (o.closeFirst && o.closeName) closeMcpConnection(o.closeName);  // R5-F2
  if (o.mutate) next = await mutateMcpConfig(o.mutate);  // R22-F2: 互斥读改写
  if (!o.closeFirst && o.closeName) closeMcpConnection(o.closeName);
  const mounts = await rebuildMounts(AGENT_KEYS);
  // mutate 调用方要配置列表(skills/rebuild 等 rebuild-only 调用方要
  // 挂载结果)——此前 rebuild-only 返回 undefined 打穿路由。
  return o.mutate ? next : mounts;
}
