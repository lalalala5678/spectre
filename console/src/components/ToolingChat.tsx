import { useEffect, useState } from 'react';
import { Bot, RefreshCw } from 'lucide-react';

import { api } from '../api/client';
import type { ApiSessionSummary } from '../api/client';
import { LiveSession } from './session/LiveSession';
import { cn } from '../utils/cn';

// CS44-F16: 直接用 api/client 导出接口(此前手抄 5 字段孪生——新增
// 字段(title/brief/spawnName 等)手抄本全缺, 双胞胎形状漂移温床)。

/**
 * Embedded config-agent chat. Each management page binds to ITS OWN
 * config agent (SkillsPage→skill-config, McpPage→mcp-config,
 * CliPage→cli-config) with a separate conversation per agentKey —
 * boundary axiom: never a shared session, never inside other agents'
 * workspaces.
 */
export function ToolingChat({ agentKey, workSessionId }: { agentKey: string; workSessionId: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const boot = async () => {
    setError('');
    setSessionId(null);
    try {
      const all = await api<ApiSessionSummary[]>(`/sessions?workSessionId=${encodeURIComponent(workSessionId)}`);
      const mine = all.filter(s => s.agentKey === agentKey
        && !s.engagementId && !s.parentSessionId
        && s.workSessionId === workSessionId);
      if (mine.length > 0) {
        setSessionId(mine[mine.length - 1].id);
        return;
      }
      const created = await api<ApiSessionSummary>('/sessions', {
        method: 'POST', json: { agentKey, workSessionId },
      });
      setSessionId(created.id);
    } catch (e) {
      setError(String(e));
    }
  };
  // boot 每渲染新引用, 入 deps 即循环; 语义=键变化重建会话
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void boot(); }, [agentKey, workSessionId]);

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
          ? <LiveSession agentKey={agentKey} sessionId={sessionId} />
          : !error && (
            <p className="animate-pulse py-8 text-center text-[11px] text-zinc-600">
              正在连接智能体 会话…
            </p>
          )}
      </div>
    </div>
  );
}
