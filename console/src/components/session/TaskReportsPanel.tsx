import { cn } from '../../utils/cn';

import type { ApiBusEvent } from '../../api/client';
import { useBusPanelEntries } from '../../api/useBusPanelEntries';
import { PanelEntryMeta } from './PanelEntryMeta';
import { StatusBadge } from './VulnPanel';

/**
 * 任务报告 panel: the process record of every finished task (mandatory,
 * system-enforced — synthesized on refusal or transport failure). Status
 * badge + title + provenance line. SSE-driven (snapshot + live events);
 * scoped to the current project (work session).
 */
export function TaskReportsPanel({ workSessionId, onOpen }: {
  workSessionId?: string;
  onOpen: (event: ApiBusEvent) => void;
}) {
  // R3-1 对齐: 先折后滤(同 Vuln/Intel——TR 的 accept 不看 origin, 行为
  // 等效但顺序统一, 修订不再依赖巧合)。
  const accept = (e: ApiBusEvent) =>
    e.type === 'task-report' && e.workSessionId === workSessionId;
  const { events, loaded } = useBusPanelEntries(accept, { ws: workSessionId });

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded border border-void-700 bg-void-850">
      <header className="flex items-center justify-between border-b border-void-700 px-3 py-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
          任务报告
        </h3>
        <span className="font-mono text-[10px] text-zinc-600">{events.length}</span>
      </header>
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {events.length === 0 && (!loaded
          ? <p className="animate-pulse py-3 text-center text-[11px] text-zinc-600">载入中…</p>
          : <p className="py-3 text-center text-[11px] text-zinc-700">本项目暂无任务报告</p>
        )}
        {events.map(event => {
          // F56: render the CURRENT version (current = latest revision) —
          // reading the original's fields left the list showing the stale
          // title/status after a revision landed.
          const cur = event.current ?? event;
          return (
            <button
              key={event.seq}
              onClick={() => onOpen(event)}
              className="flex w-full flex-col gap-px rounded-sm border border-void-700 bg-void-900 px-2 py-1.5 text-left hover:border-void-500"
            >
              <div className="flex w-full items-center gap-2">
                <StatusBadge status={cur.status ?? 'no-result'} />
                <span className={cn('min-w-0 flex-1 truncate text-[12.5px]',
                  cur.void ? 'text-zinc-500 line-through' : 'text-zinc-300')}>
                  {cur.title ?? cur.summary}
                </span>
                <PanelEntryMeta event={event} voidable />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
