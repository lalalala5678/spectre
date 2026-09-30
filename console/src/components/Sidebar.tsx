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
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-void-700 bg-void-900">
      {/* 品牌区：自绘图标 + 文本标识 */}
      <div className="flex items-center gap-2.5 border-b border-void-700 px-3.5 py-3">
        <SpectreMark />
        <div>
          <div className="text-[13px] font-semibold tracking-widest text-zinc-100">SPECTRE</div>
          <div className="mt-px text-[10px] text-zinc-600">SPECTRE · agent console</div>
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
        <div className="font-mono text-[10px] text-zinc-600">v0.4.0 · MIT</div>
      </div>
    </aside>
  );
}
