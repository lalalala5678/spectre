import { ClipboardList } from 'lucide-react';

import type { ApiBusEvent } from '../../api/client';
import { useBusPanelEntries } from '../../api/useBusPanelEntries';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { PanelEntryMeta } from './PanelEntryMeta';
import { StatusBadge } from './VulnPanel';
import { cn } from '../../utils/cn';

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
    <div className="animate-enter flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-surface shadow-xs">
      <header className="flex items-center justify-between border-b border-line bg-surface-2/50 px-3 py-1.5">
        <h3 className="text-[13px] font-semibold text-secondary">
          任务报告
        </h3>
        <span className="text-xs tabular-nums text-tertiary">{events.length}</span>
      </header>
      <div className="flex-1 space-y-1 overflow-y-auto p-2" tabIndex={0} aria-label="任务报告列表">
        {events.length === 0 && (!loaded
          ? <Skeleton className="mx-1 my-2 h-11" />
          : <EmptyState icon={ClipboardList} title="本项目暂无任务报告" />
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
              className="flex min-h-11 w-full flex-col gap-px rounded-md border border-line-strong bg-surface px-2 py-1.5 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <div className="flex w-full items-center gap-2">
                <StatusBadge status={cur.status ?? 'no-result'} />
                <span className={cn('min-w-0 flex-1 truncate text-sm font-medium',
                  cur.void ? 'text-tertiary line-through' : 'text-primary')}>
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
