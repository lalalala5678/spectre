import i18n from '../i18n';
import {
  Radar, Bug, KeyRound, Braces, Swords, Fish, Radio, Anchor, Network, FileText,
  Puzzle, Plug, Zap, ClipboardList, TerminalSquare, Gauge } from 'lucide-react';
import type React from 'react';
import type { RouteKey } from '../types';

/** i18n 消费: label 经 t() 国际化(模块级 i18n.t, 非 hook), sub 保持技术术语不翻 */
const t = (key: string) => i18n.t(key);

/** 侧栏导航表(CS1-oxlint: 从 Sidebar.tsx 挪出——组件文件混出非组件
 * 导出违反 only-export-components, Fast Refresh 边界失效)。 */
export const NAV: {
  key: RouteKey; label: string; sub: string;
  icon: React.ElementType; group: 'mode' | 'stage' | 'system';
}[] = [
  { key: 'overview', label: t('nav.overview'), sub: '项目态势仪表盘', icon: Gauge, group: 'mode' },
  { key: 'autopwn', label: t('nav.autopwn'), sub: '一体式自主渗透', icon: Zap, group: 'mode' },
  { key: 'recon', label: t('nav.recon'), sub: 'Recon Agent', icon: Radar, group: 'stage' },
  { key: 'nday', label: t('nav.nday'), sub: 'NDay Agent', icon: Bug, group: 'stage' },
  { key: 'weakcred', label: t('nav.weakcred'), sub: 'WeakCred Agent', icon: KeyRound, group: 'stage' },
  { key: 'api', label: t('nav.api'), sub: 'API Agent', icon: Braces, group: 'stage' },
  { key: 'exploit', label: t('nav.exploit'), sub: 'VulnHunt Agent', icon: Swords, group: 'stage' },
  { key: 'phish', label: t('nav.phish'), sub: 'Phish Agent', icon: Fish, group: 'stage' },
  { key: 'c2', label: t('nav.c2'), sub: 'C2 Agent', icon: Radio, group: 'stage' },
  { key: 'persistence', label: t('nav.persistence'), sub: 'Persistence Agent', icon: Anchor, group: 'stage' },
  { key: 'postex', label: t('nav.postex'), sub: 'PostEx Agent', icon: Network, group: 'stage' },
  { key: 'report', label: t('nav.report'), sub: 'Report Agent', icon: FileText, group: 'stage' },
  { key: 'shells', label: t('nav.shells'), sub: 'C2 植入通道终端', icon: TerminalSquare, group: 'stage' },
  { key: 'reports', label: t('nav.reports'), sub: '闭环交付记录', icon: ClipboardList, group: 'system' },
  { key: 'skills', label: t('nav.skills'), sub: '自定义能力注入', icon: Puzzle, group: 'system' },
  { key: 'mcp', label: t('nav.mcp'), sub: '外部工具接入', icon: Plug, group: 'system' },
  { key: 'cli', label: t('nav.cli'), sub: '二进制导入', icon: TerminalSquare, group: 'system' },
  { key: 'settings', label: t('nav.settings'), sub: 'Agent 配置·模型·数据源', icon: ClipboardList, group: 'system' },  // R32D46-NEW-6: 文档/横幅/深链均称「设置」页——命名对齐
  { key: 'audit', label: t('nav.audit'), sub: '操作留痕', icon: ClipboardList, group: 'system' },
];
