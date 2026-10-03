import { Plus, MessageSquare } from 'lucide-react';

import type { ApiSessionSummary } from '../../api/client';
import { Button } from '../ui/Button';
import { Dot } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { cn } from '../../utils/cn';

/**
 * Per-agent conversation panel ("小会话"): "new conversation" button + the
 * numbered conversation list for THIS agent inside the current work session
 * (会话一/会话二…). Engagement children never appear — left-sidebar
 * workspaces are independent of AutoPwn.
 */
export function SessionsPanel({ sessions, currentId, onSelect, onNew }: {
  sessions: (ApiSessionSummary & { name?: string })[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="animate-enter flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-surface shadow-xs">
      <header className="flex items-center justify-between border-b border-line bg-surface-2/50 px-3 py-1.5">
        <h3 className="text-[13px] font-semibold text-secondary">
          会话
        </h3>
        <Button onClick={onNew} variant="primary" size="sm">
          <Plus className="h-3.5 w-3.5" /> 新对话
        </Button>
      </header>
      <div className="flex-1 space-y-1 overflow-y-auto p-2" tabIndex={0} aria-label="会话列表">
        {sessions.length === 0 && (
          <EmptyState icon={MessageSquare} title="暂无会话" />
        )}
        {sessions.map(session => (
          <button
            key={session.id}
            onClick={() => onSelect(session.id)}
            className={cn(
              'flex min-h-11 w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              session.id === currentId
                ? 'border-accent-text bg-accent-subtle'
                : 'border-line-strong bg-surface hover:bg-surface-2',
            )}
          >
            <Dot tone={session.busy ? 'accent' : 'neutral'} pulse={session.busy} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium text-primary">
                  {session.name ?? session.id}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-tertiary">
                  {session.messages} msgs
                </span>
              </div>
              {(session.brief || session.title) && (
                <p className="mt-px truncate text-[13px] leading-tight text-tertiary">
                  {session.brief ?? session.title}
                </p>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
