import { useEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';

import { api, type ApiSessionSummary } from '../../api/client';
import { Dot } from '../ui/Badge';
import { cn } from '../../utils/cn';

interface TreeNode {
  session: ApiSessionSummary;
  children: TreeNode[];
}

function parentOf(s: ApiSessionSummary): string | null {
  return s.parentSessionId ?? s.orchestratorSessionId ?? null;
}

function buildTree(all: ApiSessionSummary[], rootId: string): TreeNode | null {
  const root = all.find(s => s.id === rootId);
  if (!root) return null;
  const byParent = new Map<string, ApiSessionSummary[]>();
  for (const s of all) {
    if (s.id === rootId) continue;
    const p = parentOf(s);
    if (!p) continue;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p)!.push(s);
  }
  const assemble = (session: ApiSessionSummary): TreeNode => ({
    session,
    children: (byParent.get(session.id) ?? [])
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(assemble),
  });
  return assemble(root);
}

/** Fixed stage-type labels shown in the dispatch tree: 名字（类型）. */
const TYPE_LABELS: Record<string, string> = {
  autopwn: '编排agent',
  recon: '资产测绘agent',
  nday: 'Nday agent',
  weakcred: '弱口令检测agent',
  api: 'API渗透agent',
  exploit: '漏洞挖掘agent',
  phish: '钓鱼agent',
  c2: 'C2 agent',
  persistence: '权限维持agent',
  postex: '后渗透agent',
  report: '报告agent',
};

function Node({ node, depth, activeId, onDrill }: {
  node: TreeNode;
  depth: number;
  activeId: string | null;
  onDrill: (id: string) => void;
}) {
  const { session } = node;
  const isOrch = session.agentKey === 'autopwn';
  const displayName = session.spawnName
    ?? (depth === 0 ? '主控' : session.agentKey);
  const typeLabel = TYPE_LABELS[session.agentKey] ?? session.agentKey;
  return (
    <div>
      <button
        onClick={() => onDrill(session.id)}
        style={{ marginLeft: depth * 12 }}
        className={cn(
          'mb-0.5 flex w-[calc(100%-8px)] flex-col rounded-sm border px-1.5 py-1 text-left',
          session.id === activeId
            ? 'border-orange-800 bg-orange-950/20'
            : 'border-void-700 bg-void-900 hover:border-void-500',
        )}
      >
        <div className="flex w-full items-center gap-1.5">
          <Dot tone={session.busy ? 'orange' : 'slate'} pulse={session.busy} />
          {isOrch && <Bot className="h-2.5 w-2.5 shrink-0 text-orange-400" />}
          <span className={cn(
            'truncate text-[12px]',
            isOrch ? 'font-semibold text-orange-300' : 'text-zinc-300',
          )}>
            {displayName}
          </span>
          <span className="shrink-0 text-[10px] text-zinc-500">
            （{typeLabel}）
          </span>
          {depth > 0 && (
            <span className="shrink-0 font-mono text-[9px] text-zinc-600">L{depth}</span>
          )}
          <span className="ml-auto shrink-0 font-mono text-[9.5px] text-zinc-600">
            {session.busy ? '运行中' : '结束'}
          </span>
        </div>
        {session.spawnDescription && (
          <p className="mt-0.5 truncate pl-4 text-[10px] leading-tight text-zinc-600">
            {session.spawnDescription}
          </p>
        )}
      </button>
      {node.children.map(child => (
        <Node
          key={child.session.id}
          node={child}
          depth={depth + 1}
          activeId={activeId}
          onDrill={onDrill}
        />
      ))}
    </div>
  );
}

/**
 * 编排树 (dispatch tree): root orchestrator → spawned agents → their
 * spawns… Click drills into that agent's live session. Root selection is
 * the workspace's current orchestrator conversation.
 */
export function DispatchTreePanel({ rootId, activeId, onDrill }: {
  rootId: string | null;
  activeId: string | null;
  onDrill: (id: string) => void;
}) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const lastSig = useRef('');

  useEffect(() => {
    // Project switch: the OLD project's tree must vanish immediately —
    // stale topology lingering behind a switched header is exactly the
    // "still showing project four" confusion.
    setTree(null);
    let stopped = false;
    const load = async () => {
      try {
        const all = await api<ApiSessionSummary[]>('/sessions');
        if (stopped) return;
        // Dedup: identical topology/state must not rebuild the tree —
        // poll re-renders are pure waste. rootId is part of the
        // signature: the mount-time load runs with rootId='' (bootstrap
        // pending) and MUST NOT poison the marker for the real root.
        const sig = `${rootId ?? ''}#` + all.map(s => `${s.id}:${s.busy ? 1 : 0}`
          + `:${s.spawnName ?? ''}:${s.messages}:${s.title ?? ''}`).join('|');
        lastSig.current = sig;
        setTree(buildTree(all, rootId ?? ''));
      } catch { /* retry next tick */ }
    };
    load();
    const timer = setInterval(load, 4000);
    return () => { stopped = true; clearInterval(timer); };
  }, [rootId]);

  const count = tree ? 1 + tree.children.length : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded border border-void-700 bg-void-850">
      <header className="flex items-center justify-between border-b border-void-700 px-3 py-1.5">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
          编排树
        </h3>
        <span className="font-mono text-[10px] text-zinc-600">{count} 节点</span>
      </header>
      <div className="flex-1 overflow-y-auto p-1.5">
        {!tree && (
          <p className="py-3 text-center text-[11px] text-zinc-700">
            {rootId ? '载入中…' : '无主控会话'}
          </p>
        )}
        {tree && (
          <Node node={tree} depth={0} activeId={activeId} onDrill={onDrill} />
        )}
      </div>
    </div>
  );
}
