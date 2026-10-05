import { Lightbulb } from 'lucide-react';

import type { ApiBusEvent } from '../../api/client';
import { useBusPanelEntries } from '../../api/useBusPanelEntries';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { PanelEntryMeta } from './PanelEntryMeta';
import { cn } from '../../utils/cn';
import { stripEventTitle } from './eventTitle';

/**
 * INTEL-NOTE list panel: any information that might help the task
 * (leads, observations, environment details, hypotheses). Info tone
 * distinguishes it from the vulnerability ledger. SSE-driven;
 * `agentKey` scopes the feed to notes authored by that agent only.
 */
export function IntelNotesPanel({ agentKey, workSessionId, onOpen }: {
  agentKey?: string;
  workSessionId?: string;
  onOpen: (event: ApiBusEvent) => void;
}) {
  // R3-1: accept 判 ORIGINAL 身份——修订事件在折后才被剔除(同 VulnPanel)。
  const accept = (e: ApiBusEvent) => {
    if (e.type !== 'intel-note') return false;
    if (!agentKey) {
      // AutoPwn feed: engagement intel notes of this project
      return e.workSessionId === workSessionId;
    }
    // direct workspace: own notes from own conversations only
    return e.from === agentKey
      && e.origin === 'direct'
      && e.workSessionId === workSessionId;
  };
  const { events, loaded, total, more } = useBusPanelEntries(accept, { ws: workSessionId });

  return (
    <div className="animate-enter flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-surface shadow-xs">
      <header className="flex items-center justify-between border-b border-line bg-surface-2/50 px-3 py-1.5">
        <h3 className="text-[13px] font-semibold text-secondary">
          情报
        </h3>
        <span className="text-xs tabular-nums text-tertiary">
          {events.length}/{total}{total > events.length && (
            <button onClick={more} className="ml-1 rounded px-1 text-accent-text hover:bg-surface-2">更多</button>
          )}
        </span>
      </header>
      <div className="flex-1 space-y-1 overflow-y-auto p-2" tabIndex={0} aria-label="情报列表">
        {events.length === 0 && (!loaded
          ? <Skeleton className="mx-1 my-2 h-11" />
          : <EmptyState icon={Lightbulb} title="暂无情报" />
        )}
        {events.map(event => {
          const title = event.current.title ?? event.title
            ?? stripEventTitle(event.summary);  // CS44-F9: 单源
          return (
            <button
              key={event.seq}
              onClick={() => onOpen(event)}
              className="flex min-h-10 w-full flex-col gap-0 rounded-md border border-line-strong bg-surface px-2 py-1 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <div className="@container flex w-full items-center gap-2">
                <Badge tone="info" className="shrink-0">
                  情报
                </Badge>
                <span className={cn('relative z-20 min-w-0 flex-1 truncate text-sm font-medium',
                  event.current.void ? 'text-tertiary line-through' : 'text-primary')}>
                  {title}
                </span>
                {event.revisedCount > 0 && (
                  <Badge tone="info" className="shrink-0 tabular-nums">⟳{event.revisedCount}</Badge>
                )}
                {/* CS41-C2→r45: 溯源行移出标题行——标题独占一行永远完整
                    (用户令: 同行竞争曾致标题被挡), 溯源独立第二行。 */}
              </div>
              <PanelEntryMeta event={event} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
