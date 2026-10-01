import { cn } from '../../utils/cn';

import type { ApiBusEvent } from '../../api/client';
import { useBusPanelEntries } from '../../api/useBusPanelEntries';
import { PanelEntryMeta } from './PanelEntryMeta';
import { stripEventTitle } from './eventTitle';

/**
 * INTEL-NOTE list panel: any information that might help the task
 * (leads, observations, environment details, hypotheses). Teal (CS44-F11 补落: 实色 teal——emerald 在 VulnPanel)
 * accent distinguishes it from the vulnerability ledger. SSE-driven;
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
  const { events, loaded } = useBusPanelEntries(accept, { ws: workSessionId });

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded border border-void-700 bg-void-850">
      <header className="flex items-center justify-between border-b border-void-700 px-3 py-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-teal-500/80">
          情报 INTEL
        </h3>
        <span className="font-mono text-[10px] text-zinc-600">{events.length}</span>
      </header>
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {events.length === 0 && (!loaded
          ? <p className="animate-pulse py-3 text-center text-[11px] text-zinc-600">载入中…</p>
          : <p className="py-3 text-center text-[11px] text-zinc-700">暂无情报</p>
        )}
        {events.map(event => {
          const title = event.current.title ?? event.title
            ?? stripEventTitle(event.summary);  // CS44-F9: 单源
          return (
            <button
              key={event.seq}
              onClick={() => onOpen(event)}
              className="flex w-full flex-col gap-px rounded-sm border border-teal-900/50 bg-teal-950/10 px-2 py-1.5 text-left hover:border-teal-700"
            >
              <div className="flex w-full items-center gap-2">
                <span className="shrink-0 rounded-sm border border-teal-800 bg-teal-950/60 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-teal-400">
                  情报
                </span>
                <span className={cn('min-w-0 flex-1 truncate text-[12.5px]',
                  event.current.void ? 'text-zinc-500 line-through' : 'text-zinc-300')}>
                  {title}
                </span>
                {/* CS41-C2: 收敛 PanelEntryMeta(⟳ 徽标+溯源行——此前
                    内联逐字双胞胎, 同族三面板两收敛一分叉) */}
                <PanelEntryMeta event={event} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
