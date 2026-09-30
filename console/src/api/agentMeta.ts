/**
 * Agent 元数据查找(CS1-oxlint: 此前 export 在 AgentWorkspacePage.tsx
 * 内, 违反 react/only-export-components——组件文件混出非组件使 Fast
 * Refresh 边界失效, 改这两个文件会整树 remount)。
 */
import { AGENTS } from './agentRegistry';
import type { AgentMeta } from '../types';

export function getAgent(id: string): AgentMeta {
  return AGENTS.find(a => a.id === id) ?? AGENTS[0];
}
