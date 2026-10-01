import {
  Radar, Bug, KeyRound, Braces, Swords, Fish, Radio, Anchor, Network, FileText,
  Puzzle, Plug, Zap, ClipboardList, TerminalSquare } from 'lucide-react';
import type React from 'react';
import type { RouteKey } from '../types';

/** 侧栏导航表(CS1-oxlint: 从 Sidebar.tsx 挪出——组件文件混出非组件
 * 导出违反 only-export-components, Fast Refresh 边界失效)。 */
export const NAV: {
  key: RouteKey; label: string; sub: string;
  icon: React.ElementType; group: 'mode' | 'stage' | 'system';
}[] = [
  { key: 'autopwn', label: 'AutoPwn', sub: '一体式自主渗透', icon: Zap, group: 'mode' },
  { key: 'recon', label: '资产测绘 & 指纹', sub: 'Recon Agent', icon: Radar, group: 'stage' },
  { key: 'nday', label: 'N-Day & 变体', sub: 'NDay Agent', icon: Bug, group: 'stage' },
  { key: 'weakcred', label: '弱口令检测', sub: 'WeakCred Agent', icon: KeyRound, group: 'stage' },
  { key: 'api', label: 'API 渗透', sub: 'API Agent', icon: Braces, group: 'stage' },
  { key: 'exploit', label: '漏洞挖掘', sub: 'VulnHunt Agent', icon: Swords, group: 'stage' },
  { key: 'phish', label: '钓鱼', sub: 'Phish Agent', icon: Fish, group: 'stage' },
  { key: 'c2', label: 'C2 & 内存马', sub: 'C2 Agent', icon: Radio, group: 'stage' },
  { key: 'persistence', label: '权限维持', sub: 'Persistence Agent', icon: Anchor, group: 'stage' },
  { key: 'postex', label: '后渗透', sub: 'PostEx Agent', icon: Network, group: 'stage' },
  { key: 'report', label: '报告编写', sub: 'Report Agent', icon: FileText, group: 'stage' },
  { key: 'shells', label: 'Shell 控制台', sub: 'C2 植入通道终端', icon: TerminalSquare, group: 'stage' },
  { key: 'reports', label: '任务报告', sub: '闭环交付记录', icon: ClipboardList, group: 'system' },
  { key: 'skills', label: 'Skill 管理', sub: '自定义能力注入', icon: Puzzle, group: 'system' },
  { key: 'mcp', label: 'MCP Server', sub: '外部工具接入', icon: Plug, group: 'system' },
  { key: 'cli', label: 'CLI 工具', sub: '二进制导入', icon: TerminalSquare, group: 'system' },
  { key: 'settings', label: '设置', sub: 'Agent 配置·模型·数据源', icon: ClipboardList, group: 'system' },  // R32D46-NEW-6: 文档/横幅/深链均称「设置」页——命名对齐
  { key: 'audit', label: '审计与证据链', sub: '操作留痕', icon: ClipboardList, group: 'system' },
];
