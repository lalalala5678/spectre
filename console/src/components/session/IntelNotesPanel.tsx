import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';

import { api, foldEntries, subscribeSse, type ApiBusEvent } from '../../api/client';

type FoldedEntry = ApiBusEvent & { current: ApiBusEvent; revisedCount: number };

/**
 * INTEL-NOTE list panel: any information that might help the task
 * (leads, observations, environment details, hypotheses). Emerald
 * accent distinguishes it from the vulnerability ledger. SSE-driven;
 * `agentKey` scopes the feed to notes authored by that agent only.
 */
export function IntelNotesPanel({ agentKey, workSessionId, onOpen }: {
  agentKey?: string;
  workSessionId?: string;
  onOpen: (event: ApiBusEvent) => void;
}) {
  const [events, setEvents] = useState<FoldedEntry[]>([]);
  // Distinguish LOADING (project switched, fetch in flight) from EMPTY
  // (project loaded, nothing published) — stale content must never
  // linger after a project switch, and '暂无' must never flash first.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let stopped = false;
    const cursor = { v: 0 };
    setEvents([]);
    setLoaded(false);
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
    (async () => {
      try {
        const all = await api<ApiBusEvent[]>('/bus'
          + (workSessionId ? `?ws=${workSessionId}` : ''));
        if (stopped) return;
        setEvents(foldEntries(all.filter(accept)).slice(-20).reverse());
        setLoaded(true);
        cursor.v = all.at(-1)?.seq ?? 0;
      } catch { /* SSE reconnect will heal */ }
    })();
    const off = subscribeSse('/bus/events', (name, raw) => {
      if (name !== 'bus') return;
      const e = raw as ApiBusEvent;
      if (e.seq <= cursor.v) return;
      cursor.v = e.seq;
      if (e.revises) {
        // revision landed — refetch to fold the new current version
        void (async () => {
          try {
            const all = await api<ApiBusEvent[]>('/bus'
          + (workSessionId ? `?ws=${workSessionId}` : ''));
            setEvents(foldEntries(all.filter(accept)).slice(-20).reverse());
            setLoaded(true);
          } catch { /* next event heals */ }
        })();
        return;
      }
      if (!accept(e)) return;
      setEvents(prev => prev.some(x => x.seq === e.seq)
        ? prev : [{ ...e, current: e, revisedCount: 0 } as FoldedEntry, ...prev].slice(0, 20));
    }, () => cursor.v);
    return () => { stopped = true; off(); };
  }, [agentKey, workSessionId]);

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
            ?? event.summary.replace(/^(情报)[:：]?/, '').slice(0, 60);
          const a = event.author;
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
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-300">
                  {title}
                </span>
                {event.revisedCount > 0 && (
                  <span className="shrink-0 rounded-sm border border-sky-800 bg-sky-950/40 px-1 py-0.5 font-mono text-[8.5px] tracking-widest text-sky-300">
                    ⟳{event.revisedCount}
                  </span>
                )}
                <ChevronRight className="h-3 w-3 shrink-0 text-zinc-600" />
              </div>
              {a && (
                <p className="truncate pl-1 text-[10px] leading-tight text-zinc-600">
                  {a.name}（{a.typeLabel}{a.parent ? ` · 父:${a.parent.name}` : ''} · L{a.depth}）
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
