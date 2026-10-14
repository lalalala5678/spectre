import { useMemo, useState } from 'react';
import { ShieldAlert, Search } from 'lucide-react';
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
  const [sevFilter, setSevFilter] = useState<string | null>(null);
  const [q, setQ] = useState('');
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

  const filtered = useMemo(() => {
    if (!sevFilter && !q.trim()) return events;
    const ql = q.trim().toLowerCase();
    return events.filter(e => {
      if (sevFilter) {
        const s = String(e.current.severity ?? e.severity ?? 'info').toLowerCase();
        if (s !== sevFilter) return false;
      }
      if (ql) {
        const hay = `${e.current.title ?? e.title ?? ''} ${e.current.summary ?? e.summary ?? ''}`.toLowerCase();
        if (!hay.includes(ql)) return false;
      }
      return true;
    });
  }, [events, sevFilter, q]);

  return (
    <div className="animate-enter flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-surface shadow-xs">
      <header className="flex items-center justify-between border-b border-line bg-surface-2/50 px-3 py-1.5">
        <h3 className="text-[13px] font-semibold text-secondary">漏洞</h3>
        <div className="flex items-center gap-1.5">
          {/* severity segmented filter */}
          {['critical', 'high', 'medium', 'low', 'info'].map(s => (
            <button key={s}
              onClick={() => setSevFilter(sevFilter === s ? null : s)}
              className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums transition-colors',
                sevFilter === s ? SEVERITY_ACTIVE[s] : 'text-tertiary hover:bg-surface-3')}
              title={sevFilter === s ? `取消 ${s} 筛选` : `只看 ${s}`}
            >
              {s === 'critical' ? '严重' : s === 'high' ? '高' : s === 'medium' ? '中' : s === 'low' ? '低' : '信息'}
            </button>
          ))}
          <span className="text-xs tabular-nums text-tertiary">
            {filtered.length !== events.length ? `${filtered.length}/${events.length}` : events.length}
          </span>
        </div>
      </header>
      {/* text search */}
      <div className="shrink-0 border-b border-line px-2 py-1">
        <div className="flex items-center gap-1.5">
          <Search className="h-3 w-3 shrink-0 text-faint" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="搜索标题…"
            className="w-full bg-transparent text-xs text-primary placeholder:text-faint focus:outline-none"
          />
          {q && (
            <button onClick={() => setQ('')} className="text-[10px] text-faint hover:text-tertiary">清除</button>
          )}
        </div>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-2" tabIndex={0} aria-label="漏洞列表">
        {filtered.length === 0 && (!loaded
          ? <Skeleton className="mx-1 my-2 h-11" />
          : <EmptyState icon={ShieldAlert} title={sevFilter || q ? "无匹配漏洞" : "暂无漏洞"} />
        )}
        {filtered.map(event => {
          const severity = String(event.current.severity ?? event.severity ?? 'info').toLowerCase();
          const title = event.current.title ?? event.title
            ?? stripEventTitle(event.summary);
          return (
            <div
              key={event.seq}
              className="@container [contain-intrinsic-size:auto_54px] [content-visibility:auto] flex min-h-10 w-full flex-col gap-0 rounded-md border border-line-strong bg-surface px-2 py-1 text-left hover:bg-surface-2"
            >
              <button
                onClick={() => onOpen(event)}
                className="relative z-20 flex min-h-7 w-full items-center gap-2 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <SeverityBadge severity={severity} />
                <span className={cn('relative z-20 min-w-0 flex-1 truncate text-sm font-medium',
                  event.current.void ? 'text-tertiary line-through' : 'text-primary')}>
                  {title}
                </span>
                {event.revisedCount > 0 && (
                  <Badge tone="info" className="shrink-0 tabular-nums">⟳{event.revisedCount}</Badge>
                )}
              </button>
              <PanelEntryMeta event={event} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const SEVERITY_ACTIVE: Record<string, string> = {
  critical: 'bg-danger-bg text-danger-text font-semibold',
  high: 'bg-warning-bg text-warning-text font-semibold',
  medium: 'bg-info-bg text-info-text font-semibold',
  low: 'bg-surface-3 text-secondary font-semibold',
  info: 'bg-surface-3 text-secondary font-semibold',
};
