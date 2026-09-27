import { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';

import { api, type ApiSessionSummary } from '../../api/client';
import { Dot } from '../ui/Badge';

/**
 * Sub-agents spawned by the orchestrator (engagement children), running
 * and finished. Click drills into that child's live session.
 */
export function SubAgentsPanel({ workSessionId, onDrill }: {
  workSessionId: string;
  onDrill: (sessionId: string) => void;
}) {
  const [children, setChildren] = useState<ApiSessionSummary[]>([]);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const all = await api<ApiSessionSummary[]>(`/sessions?workSessionId=${encodeURIComponent(workSessionId)}`);
        if (!stopped) {
          // project isolation: only children spawned in this project
          setChildren(all.filter(s =>
            s.engagementId && s.workSessionId === workSessionId,
          ).slice().reverse());
        }
      } catch { /* gateway auth expired — next poll retries */ }
    };
    load();
    const timer = setInterval(load, 4000);
    return () => { stopped = true; clearInterval(timer); };
  }, [workSessionId]);

  return (
    <div className="rounded border border-void-700 bg-void-850">
      <header className="flex items-center justify-between border-b border-void-700 px-3 py-1.5">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
          子 Agent
        </h3>
        <span className="font-mono text-[9px] text-zinc-600">{children.length}</span>
      </header>
      <div className="max-h-72 space-y-1 overflow-y-auto p-2">
        {children.length === 0 && (
          <p className="py-3 text-center text-[10.5px] text-zinc-700">
            尚无子智能体 — 让编排器调度一次
          </p>
        )}
        {children.map(child => (
          <button
            key={child.id}
            onClick={() => onDrill(child.id)}
            className="flex w-full items-center gap-2 rounded-sm border border-void-700 bg-void-900 px-2 py-1.5 text-left hover:border-void-500"
          >
            <Bot className="h-3 w-3 shrink-0 text-zinc-500" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-1">
                <span className="truncate font-mono text-[11px] text-zinc-200">
                  {child.agentKey}
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[9px] text-zinc-600">
                  <Dot tone={child.busy ? 'orange' : 'slate'} pulse={child.busy} />
                  {child.busy ? '运行中' : '结束'}
                </span>
              </div>
              <div className="truncate text-[9px] text-zinc-600">
                {child.engagementId} · {child.messages} msgs
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
