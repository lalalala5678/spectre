import {
  Radar, Bug, KeyRound, Braces, Swords, Fish, Radio, Anchor, Network, FileText,
  Puzzle, Plug, Zap, ClipboardList, TerminalSquare } from 'lucide-react';
import type { RouteKey } from '../types';
import { cn } from '../utils/cn';
import { Dot } from './ui/Badge';
import { SpectreMark } from './SpectreMark';

export const NAV: { key: RouteKey; label: string; sub: string; icon: React.ElementType; group: 'mode' | 'stage' | 'system' }[] = [
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
  { key: 'skills', label: 'Skill 管理', sub: '自定义导入', icon: Puzzle, group: 'system' },
  { key: 'mcp', label: 'MCP Server', sub: '工具链接入', icon: Plug, group: 'system' },
  { key: 'cli', label: 'CLI 工具', sub: '二进制导入', icon: TerminalSquare, group: 'system' },
  { key: 'settings', label: 'Agent 配置', sub: '模型·数据源·压缩', icon: ClipboardList, group: 'system' },
  { key: 'audit', label: '审计与证据链', sub: '操作留痕', icon: ClipboardList, group: 'system' },
];

export function Sidebar({
  route,
  onRoute,
  runningCount,
}: {
  route: RouteKey;
  onRoute: (r: RouteKey) => void;
  runningCount: number;
}) {
  const groups: { id: 'mode' | 'stage' | 'system'; label: string }[] = [
    { id: 'mode', label: '自主模式' },
    { id: 'stage', label: '渗透阶段' },
    { id: 'system', label: '平台配置' },
  ];

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-void-700 bg-void-900">
      {/* 品牌区：自绘图标 + 文本标识 */}
      <div className="flex items-center gap-2.5 border-b border-void-700 px-3.5 py-3">
        <SpectreMark />
        <div>
          <div className="text-[13px] font-semibold tracking-widest text-zinc-100">SPECTRE</div>
          <div className="mt-px text-[10px] text-zinc-600">blackbox · agent console</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-2.5">
        {groups.map((g) => (
          <div key={g.id} className="mb-3.5">
            <div className="px-1.5 pb-1 text-[9.5px] font-semibold uppercase tracking-widest text-zinc-600">
              {g.label}
            </div>
            <div>
              {NAV.filter((n) => n.group === g.id).map((n) => {
                const active = route === n.key;
                const Icon = n.icon;
                return (
                  <button
                    key={n.key}
                    onClick={() => onRoute(n.key)}
                    className={cn(
                      'group flex w-full items-center gap-2 rounded-sm border-l-2 px-1.5 py-1.5 text-left transition-colors',
                      active
                        ? 'border-orange-500 bg-void-800 text-zinc-100'
                        : 'border-transparent text-zinc-500 hover:bg-void-800/70 hover:text-zinc-300',
                    )}
                  >
                    <Icon className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-orange-400' : 'text-zinc-600 group-hover:text-zinc-500')} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[12.5px] font-medium">{n.label}</span>
                        {n.key === 'autopwn' && runningCount > 0 && <Dot tone="orange" pulse />}
                      </span>
                      <span className="block truncate text-[10px] text-zinc-600">{n.sub}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* 底部：开源项目标识 */}
      <div className="border-t border-void-700 px-3.5 py-2.5">
        <div className="font-mono text-[10px] text-zinc-600">v0.4.0 · AGPL-3.0</div>
      </div>
    </aside>
  );
}
