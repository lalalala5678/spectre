import { Plus } from 'lucide-react';

import type { ApiSessionSummary } from '../../api/client';
import { Dot } from '../ui/Badge';
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
    <div className="flex min-h-0 flex-1 flex-col rounded border border-void-700 bg-void-850">
      <header className="flex items-center justify-between border-b border-void-700 px-3 py-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
          会话
        </h3>
        <button
          onClick={onNew}
          className="flex items-center gap-1 rounded-sm bg-orange-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-orange-500"
        >
          <Plus className="h-3 w-3" /> 新对话
        </button>
      </header>
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {sessions.length === 0 && (
          <p className="py-3 text-center text-[11px] text-zinc-700">暂无会话</p>
        )}
        {sessions.map(session => (
          <button
            key={session.id}
            onClick={() => onSelect(session.id)}
            className={cn(
              'flex w-full items-center gap-2 rounded-sm border px-2 py-1.5 text-left',
              session.id === currentId
                ? 'border-orange-800 bg-orange-950/20'
                : 'border-void-700 bg-void-900 hover:border-void-500',
            )}
          >
            <Dot tone={session.busy ? 'orange' : 'slate'} pulse={session.busy} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[12.5px] text-zinc-300">
                  {session.name ?? session.id}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-zinc-600">
                  {session.messages} msgs
                </span>
              </div>
              {(session.brief || session.title) && (
                <p className="mt-px truncate text-[10.5px] leading-tight text-zinc-500">
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
