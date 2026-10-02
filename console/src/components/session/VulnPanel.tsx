import { MessageSquareText, ShieldAlert } from 'lucide-react';

import type { ApiBusEvent } from '../../api/client';
import { useBusPanelEntries } from '../../api/useBusPanelEntries';
import { Badge, type BadgeTone } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { PanelEntryMeta } from './PanelEntryMeta';
import { cn } from '../../utils/cn';
import { stripEventTitle } from './eventTitle';

// CS3-N21: 大小写双胞胎删除——severity 在修订/发布入口已归一小写;
// 显示侧兜底 toLowerCase。§5.5 tone 映射。
const SEVERITY_TONES: Record<string, BadgeTone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'info',
  info: 'info',
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <Badge tone={SEVERITY_TONES[severity] ?? 'neutral'} className="shrink-0">
      {severity}
    </Badge>
  );
}

const STATUS_TONES: Record<string, BadgeTone> = {
  success: 'success',
  partial: 'warning',
  failed: 'danger',
  'no-result': 'neutral',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONES[status] ?? STATUS_TONES['no-result']} className="shrink-0">
      {status}
    </Badge>
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
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-surface">
      <header className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <h3 className="text-xs font-semibold text-secondary">
          漏洞 VULNS
        </h3>
        <span className="text-xs tabular-nums text-tertiary">{events.length}</span>
      </header>
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {events.length === 0 && (!loaded
          ? <Skeleton className="mx-1 my-2 h-11" />
          : <EmptyState icon={ShieldAlert} title="暂无漏洞" />
        )}
        {events.map(event => {
          const severity = String(event.current.severity ?? event.severity ?? 'info').toLowerCase();  // CS3-N21
          const title = event.current.title ?? event.title
            ?? stripEventTitle(event.summary);  // CS44-F9: 单源
          return (
            <button
              key={event.seq}
              onClick={() => onOpen(event)}
              className="flex min-h-11 w-full flex-col gap-px rounded-md border border-line bg-surface px-2 py-1.5 text-left hover:bg-surface-2"
            >
              <div className="flex w-full items-center gap-2">
                <SeverityBadge severity={severity} />
                <span className={cn('min-w-0 flex-1 truncate text-sm font-medium',
                  event.current.void ? 'text-tertiary line-through' : 'text-primary')}>
                  {title}
                </span>
                {event.payloadRef?.startsWith('sess:') && onOpenSession && (
                  <span
                    role="button"
                    tabIndex={0}
                    title="查看撰写对话（思考 · 工具调用 · 验证过程）"
                    onClick={e => { e.stopPropagation(); onOpenSession(event.payloadRef!.slice(5)); }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); onOpenSession(event.payloadRef!.slice(5)); } }}
                    className="shrink-0 rounded-md p-0.5 text-accent-text/70 hover:text-accent-text"
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
