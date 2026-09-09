import { useEffect, useState } from 'react';
import { Bot, RefreshCw } from 'lucide-react';

import { api } from '../api/client';
import { LiveSession } from './session/LiveSession';
import { cn } from '../utils/cn';

interface ApiSessionSummary {
  id: string;
  agentKey: string;
  workSessionId: string | null;
  engagementId: string | null;
  parentSessionId: string | null;
}

/**
 * Embedded tooling-agent chat — the SAME `tools` conversation shared by
 * the Skills / MCP / CLI management pages (one agent, three aspects,
 * continuous context). Mount isolation unchanged: this is a tools-key
 * session; it never appears inside other agents' workspaces.
 */
export function ToolingChat({ workSessionId }: { workSessionId: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const boot = async () => {
    setError('');
    setSessionId(null);
    try {
      const all = await api<ApiSessionSummary[]>('/sessions');
      const mine = all.filter(s => s.agentKey === 'tools'
        && !s.engagementId && !s.parentSessionId
        && s.workSessionId === workSessionId);
      if (mine.length > 0) {
        setSessionId(mine[mine.length - 1].id);
        return;
      }
      const created = await api<ApiSessionSummary>('/sessions', {
        method: 'POST', json: { agentKey: 'tools', workSessionId },
      });
      setSessionId(created.id);
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => { void boot(); }, [workSessionId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
          <Bot className="h-3 w-3 text-orange-400/80" />
          与工具配置智能体对话
        </span>
        <button
          onClick={() => void boot()}
          title="重新连接"
          className="text-zinc-600 hover:text-zinc-300"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
      {error && (
        <p className="rounded-sm border border-red-900 bg-red-950/30 px-2 py-1 text-[11px] text-red-400">
          {error}
        </p>
      )}
      <div className={cn('min-h-[420px]', sessionId ? 'flex min-h-0 flex-1' : '')}>
        {sessionId
          ? <LiveSession agentKey="tools" sessionId={sessionId} />
          : !error && (
            <p className="animate-pulse py-8 text-center text-[11px] text-zinc-600">
              正在连接工具配置智能体…
            </p>
          )}
      </div>
    </div>
  );
}
