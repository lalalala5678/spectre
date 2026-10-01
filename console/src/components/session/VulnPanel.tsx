import { MessageSquareText } from 'lucide-react';

import type { ApiBusEvent } from '../../api/client';
import { useBusPanelEntries } from '../../api/useBusPanelEntries';
import { PanelEntryMeta } from './PanelEntryMeta';
import { cn } from '../../utils/cn';
import { stripEventTitle } from './eventTitle';

// CS3-N21: 大小写双胞胎删除——severity 在修订/发布入口已归一小写;
// 显示侧兜底 toLowerCase。
const SEVERITY_STYLES: Record<string, string> = {
  critical: 'border-red-600 bg-red-950/70 text-red-300',
  high: 'border-orange-600 bg-orange-950/70 text-orange-300',
  medium: 'border-amber-600 bg-amber-950/60 text-amber-300',
  low: 'border-sky-700 bg-sky-950/60 text-sky-300',
  info: 'border-zinc-600 bg-void-800 text-zinc-400',
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
  // R3-1: accept 判 ORIGINAL 身份(origin/from)——修订事件在折后才被剔除
  // (先滤后折会把修订全部剥掉, 面板永久显示旧 title/severity)。
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
  const { events, loaded } = useBusPanelEntries(accept, { ws: workSessionId });

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded border border-void-700 bg-void-850">
      <header className="flex items-center justify-between border-b border-void-700 px-3 py-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
          漏洞 VULNS
        </h3>
        <span className="font-mono text-[10px] text-zinc-600">{events.length}</span>
      </header>
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {events.length === 0 && (!loaded
          ? <p className="animate-pulse py-3 text-center text-[11px] text-zinc-600">载入中…</p>
          : <p className="py-3 text-center text-[11px] text-zinc-700">暂无漏洞</p>
        )}
        {events.map(event => {
          const severity = String(event.current.severity ?? event.severity ?? 'info').toLowerCase();  // CS3-N21
          const title = event.current.title ?? event.title
            ?? stripEventTitle(event.summary);  // CS44-F9: 单源
          return (
            <button
              key={event.seq}
              onClick={() => onOpen(event)}
              className="flex w-full flex-col gap-px rounded-sm border border-void-700 bg-void-900 px-2 py-1.5 text-left hover:border-void-500"
            >
              <div className="flex w-full items-center gap-2">
                <SeverityBadge severity={severity} />
                <span className={cn('min-w-0 flex-1 truncate text-[12.5px]',
                  event.current.void ? 'text-zinc-500 line-through' : 'text-zinc-300')}>
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
                <PanelEntryMeta event={event} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
