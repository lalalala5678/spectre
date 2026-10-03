import type { RouteKey } from '../types';
import { cn } from '../utils/cn';
import { NAV } from './nav';  // CS1-oxlint: 挪出的导航表
import { Dot } from './ui/Badge';
import { SpectreMark } from './SpectreMark';


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
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-chrome-line bg-chrome-surface">
      {/* 品牌区：自绘图标 + 文本标识(§6.1-1: 副标去中英重复) */}
      <div className="flex items-center gap-2.5 border-b border-chrome-line px-3.5 py-3">
        <SpectreMark tone="chrome" />
        <div>
          <div className="text-sm font-semibold text-chrome-primary">SPECTRE</div>
          <div className="mt-px text-xs text-chrome-tertiary">agent console</div>
        </div>
      </div>

      {/* Nav(§6.1-1: 单层主标签 14px/500, 副信息并入 title; 激活 accent-subtle) */}
      <nav className="flex-1 overflow-y-auto px-2 py-2.5">
        {groups.map((g) => (
          <div key={g.id} className="mb-3.5">
            <div className="px-2 pb-1 text-xs font-semibold text-chrome-tertiary">
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
                    title={n.sub}
                    className={cn(
                      'group flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                      active
                        ? 'bg-chrome-surface-2 text-chrome-accent-text'
                        : 'text-chrome-secondary hover:bg-chrome-surface-2 hover:text-chrome-primary',
                    )}
                  >
                    <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-chrome-accent-text' : 'text-chrome-tertiary group-hover:text-chrome-secondary')} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{n.label}</span>
                    {n.key === 'autopwn' && runningCount > 0 && <Dot tone="accent" pulse />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* 底部：开源项目标识 */}
      <div className="border-t border-chrome-line px-3.5 py-2.5">
        <div className="text-xs text-chrome-tertiary">v0.4.0 · MIT</div>
      </div>
    </aside>
  );
}
