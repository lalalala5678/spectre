import { useEffect, useState } from 'react';
import { ChevronRight, MessageSquareText } from 'lucide-react';

import { api, foldEntries, subscribeSse, type ApiBusEvent } from '../../api/client';

type FoldedEntry = ApiBusEvent & { current: ApiBusEvent; revisedCount: number };
import { cn } from '../../utils/cn';

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'border-red-600 bg-red-950/70 text-red-300',
  CRITICAL: 'border-red-600 bg-red-950/70 text-red-300',
  high: 'border-orange-600 bg-orange-950/70 text-orange-300',
  HIGH: 'border-orange-600 bg-orange-950/70 text-orange-300',
  medium: 'border-amber-600 bg-amber-950/60 text-amber-300',
  MEDIUM: 'border-amber-600 bg-amber-950/60 text-amber-300',
  low: 'border-sky-700 bg-sky-950/60 text-sky-300',
  LOW: 'border-sky-700 bg-sky-950/60 text-sky-300',
  info: 'border-zinc-600 bg-void-800 text-zinc-400',
  INFO: 'border-zinc-600 bg-void-800 text-zinc-400',
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span className={cn(
      'shrink-0 rounded-sm border px-1.5 py-px font-mono text-[10px] font-bold tracking-wide',
      SEVERITY_STYLES[severity] ?? 'border-zinc-700 bg-void-900 text-zinc-500',
    )}>
      {severity}
    </span>
  );
}

const STATUS_STYLES: Record<string, string> = {
  success: 'border-emerald-700 bg-emerald-950/60 text-emerald-300',
  partial: 'border-amber-600 bg-amber-950/60 text-amber-300',
  failed: 'border-red-700 bg-red-950/60 text-red-300',
  'no-result': 'border-zinc-600 bg-void-800 text-zinc-400',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn(
      'shrink-0 rounded-sm border px-1.5 py-px font-mono text-[10px] font-bold tracking-wide',
      STATUS_STYLES[status] ?? STATUS_STYLES['no-result'],
    )}>
      {status}
    </span>
  );
}

/**
 * VULNERABILITY list panel: severity badge + one-line title + provenance
 * per entry. SSE-driven (initial snapshot + live events — no polling);
 * `agentKey` scopes the feed to entries authored by that agent only.
 * Clicking opens the full content in the MAIN window (onOpen).
 */
export function VulnPanel({ agentKey, workSessionId, onOpen, onOpenSession }: {
  agentKey?: string;
  workSessionId?: string;
  onOpen: (event: ApiBusEvent) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [events, setEvents] = useState<FoldedEntry[]>([]);

  useEffect(() => {
    let stopped = false;
    const cursor = { v: 0 };
    const accept = (e: ApiBusEvent) => {
      // 'intel' = legacy pre-rename events — they ARE vulnerabilities
      if (e.type !== 'vulnerability' && e.type !== 'intel') return false;
      if (!agentKey) {
        // AutoPwn feed: engagement vulnerabilities of this project
        return e.workSessionId === workSessionId;
      }
      // direct workspace: own vulnerabilities from own conversations only
      return e.from === agentKey
        && e.origin === 'direct'
        && e.workSessionId === workSessionId;
    };
    (async () => {
      try {
        const all = await api<ApiBusEvent[]>('/bus');
        if (stopped) return;
        setEvents(foldEntries(all.filter(accept)).slice(-20).reverse());
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
            const all = await api<ApiBusEvent[]>('/bus');
            setEvents(foldEntries(all.filter(accept)).slice(-20).reverse());
          } catch { /* next event heals */ }
        })();
        return;
      }
      if (!accept(e)) return;
      // seq-guard: snapshot + SSE replay overlap must not duplicate
      setEvents(prev => prev.some(x => x.seq === e.seq)
        ? prev : [{ ...e, current: e, revisedCount: 0 } as FoldedEntry, ...prev].slice(0, 20));
    }, () => cursor.v);
    return () => { stopped = true; off(); };
  }, [agentKey, workSessionId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded border border-void-700 bg-void-850">
      <header className="flex items-center justify-between border-b border-void-700 px-3 py-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
          漏洞 VULNS
        </h3>
        <span className="font-mono text-[10px] text-zinc-600">{events.length}</span>
      </header>
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {events.length === 0 && (
          <p className="py-3 text-center text-[11px] text-zinc-700">暂无漏洞</p>
        )}
        {events.map(event => {
          const severity = event.current.severity ?? event.severity ?? 'INFO';
          const title = event.current.title ?? event.title
            ?? event.summary.replace(/^(情报上报|产出)[:：]?/, '').slice(0, 60);
          const a = event.author;
          return (
            <button
              key={event.seq}
              onClick={() => onOpen(event)}
              className="flex w-full flex-col gap-px rounded-sm border border-void-700 bg-void-900 px-2 py-1.5 text-left hover:border-void-500"
            >
              <div className="flex w-full items-center gap-2">
                <SeverityBadge severity={severity} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-300">
                  {title}
                </span>
                {event.payloadRef?.startsWith('sess:') && onOpenSession && (
                  <span
                    role="button"
                    tabIndex={0}
                    title="查看撰写对话（思考 · 工具调用 · 验证过程）"
                    onClick={e => { e.stopPropagation(); onOpenSession(event.payloadRef!.slice(5)); }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); onOpenSession(event.payloadRef!.slice(5)); } }}
                    className="shrink-0 rounded-sm p-0.5 text-orange-400/70 hover:text-orange-300"
                  >
                    <MessageSquareText className="h-3 w-3" />
                  </span>
                )}
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
