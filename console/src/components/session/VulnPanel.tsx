import { ShieldAlert } from 'lucide-react';

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
export function VulnPanel({ agentKey, workSessionId, onOpen }: {
  agentKey?: string;
  workSessionId?: string;
  onOpen: (event: ApiBusEvent) => void;
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
    <div className="animate-enter flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-surface shadow-xs">
      <header className="flex items-center justify-between border-b border-line bg-surface-2/50 px-3 py-1.5">
        <h3 className="text-[13px] font-semibold text-secondary">
          漏洞
        </h3>
        <span className="text-xs tabular-nums text-tertiary">{events.length}</span>
      </header>
      <div className="flex-1 space-y-1 overflow-y-auto p-2" tabIndex={0} aria-label="漏洞列表">
        {events.length === 0 && (!loaded
          ? <Skeleton className="mx-1 my-2 h-11" />
          : <EmptyState icon={ShieldAlert} title="暂无漏洞" />
        )}
        {events.map(event => {
          const severity = String(event.current.severity ?? event.severity ?? 'info').toLowerCase();  // CS3-N21
          const title = event.current.title ?? event.title
            ?? stripEventTitle(event.summary);  // CS44-F9: 单源
          return (
            <div
              key={event.seq}
              className="@container flex min-h-11 w-full flex-col gap-px rounded-md border border-line-strong bg-surface px-2 py-1.5 text-left hover:bg-surface-2"
            >
              {/* P3-12/nested-interactive: 行内不再嵌 interactive——主点击区
                  与"查看撰写对话"为兄弟节点(外层改 div)。 */}
              <button
                onClick={() => onOpen(event)}
                className="relative z-20 flex min-h-8 w-full items-center gap-2 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <SeverityBadge severity={severity} />
                <span className={cn('relative z-20 min-w-0 flex-1 truncate text-sm font-medium',
                  event.current.void ? 'text-tertiary line-through' : 'text-primary')}>
                  {title}
                </span>
              </button>
              {/* 用户令(r45): 溯源行独立第二行——标题独占一行永远完整 */}
              <PanelEntryMeta event={event} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
