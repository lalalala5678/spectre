import {
  Radar, Bug, KeyRound, Braces, Swords, Fish, Radio, Anchor, Network, FileText,
  Puzzle, Plug, Zap, ClipboardList, TerminalSquare, Gauge } from 'lucide-react';
import type React from 'react';
import type { RouteKey } from '../types';

/** 侧栏导航表(CS1-oxlint: 从 Sidebar.tsx 挪出——组件文件混出非组件
 * 导出违反 only-export-components, Fast Refresh 边界失效)。
 * labelKey 存 i18n 键(渲染期 t() 取词——响应式切换), sub 保持技术术语不翻。 */
export const NAV: {
  key: RouteKey; labelKey: string; sub: string;
  icon: React.ElementType; group: 'mode' | 'stage' | 'system';
}[] = [
  { key: 'overview', labelKey: 'nav.overview', sub: '项目态势仪表盘', icon: Gauge, group: 'mode' },
  { key: 'autopwn', labelKey: 'nav.autopwn', sub: '一体式自主渗透', icon: Zap, group: 'mode' },
  { key: 'recon', labelKey: 'nav.recon', sub: 'Recon Agent', icon: Radar, group: 'stage' },
  { key: 'nday', labelKey: 'nav.nday', sub: 'NDay Agent', icon: Bug, group: 'stage' },
  { key: 'weakcred', labelKey: 'nav.weakcred', sub: 'WeakCred Agent', icon: KeyRound, group: 'stage' },
  { key: 'api', labelKey: 'nav.api', sub: 'API Agent', icon: Braces, group: 'stage' },
  { key: 'exploit', labelKey: 'nav.exploit', sub: 'VulnHunt Agent', icon: Swords, group: 'stage' },
  { key: 'phish', labelKey: 'nav.phish', sub: 'Phish Agent', icon: Fish, group: 'stage' },
  { key: 'c2', labelKey: 'nav.c2', sub: 'C2 Agent', icon: Radio, group: 'stage' },
  { key: 'persistence', labelKey: 'nav.persistence', sub: 'Persistence Agent', icon: Anchor, group: 'stage' },
  { key: 'postex', labelKey: 'nav.postex', sub: 'PostEx Agent', icon: Network, group: 'stage' },
  { key: 'report', labelKey: 'nav.report', sub: 'Report Agent', icon: FileText, group: 'stage' },
  { key: 'shells', labelKey: 'nav.shells', sub: 'C2 植入通道终端', icon: TerminalSquare, group: 'stage' },
  { key: 'reports', labelKey: 'nav.reports', sub: '闭环交付记录', icon: ClipboardList, group: 'system' },
  { key: 'skills', labelKey: 'nav.skills', sub: '自定义能力注入', icon: Puzzle, group: 'system' },
  { key: 'mcp', labelKey: 'nav.mcp', sub: '外部工具接入', icon: Plug, group: 'system' },
  { key: 'cli', labelKey: 'nav.cli', sub: '二进制导入', icon: TerminalSquare, group: 'system' },
  { key: 'settings', labelKey: 'nav.settings', sub: 'Agent 配置·模型·数据源', icon: ClipboardList, group: 'system' },  // R32D46-NEW-6: 文档/横幅/深链均称「设置」页——命名对齐
  { key: 'audit', labelKey: 'nav.audit', sub: '操作留痕', icon: ClipboardList, group: 'system' },
];
