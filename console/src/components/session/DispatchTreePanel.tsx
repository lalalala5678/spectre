import { useEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';

import { api, type ApiSessionSummary } from '../../api/client';
import { Dot } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { cn } from '../../utils/cn';
import { AGENTS as REGISTRY } from '../../api/agentRegistry';

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

// CS41-C3(CS42-F15 import 移顶): 类型标签单源 agentRegistry.codename。
const TYPE_LABELS: Record<string, string> = Object.fromEntries(
  REGISTRY.map(a => [a.id, a.codename]));

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
          'mb-0.5 flex min-h-11 w-[calc(100%-8px)] flex-col rounded-md border px-1.5 py-1 text-left',
          session.id === activeId
            ? 'border-accent bg-accent-subtle'
            : 'border-line-strong bg-surface hover:bg-surface-2',
        )}
      >
        <div className="flex w-full items-center gap-1.5">
          <Dot tone={session.busy ? 'accent' : 'neutral'} pulse={session.busy} />
          {isOrch && <Bot className="h-2.5 w-2.5 shrink-0 text-accent-text" />}
          <span className={cn(
            'truncate text-[13px]',
            isOrch ? 'font-semibold text-accent-text' : 'font-medium text-primary',
          )}>
            {displayName}
          </span>
          <span className="shrink-0 text-xs text-tertiary">
            （{typeLabel}）
          </span>
          {depth > 0 && (
            <span className="shrink-0 font-mono text-xs tabular-nums text-tertiary">L{depth}</span>
          )}
          <span className="ml-auto shrink-0 text-xs text-tertiary">
            {session.busy ? '运行中' : '结束'}
          </span>
        </div>
        {session.spawnDescription && (
          <p className="mt-0.5 truncate pl-4 text-xs leading-tight text-tertiary">
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
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);  // R16-F5

  const [connError, setConnError] = useState(false);
  useEffect(() => {
    // Project switch: the OLD project's tree must vanish immediately —
    // stale topology lingering behind a switched header is exactly the
    // "still showing project four" confusion.
    setTree(null);
    setConnError(false);
    let stopped = false;
    let retryMs = 500;  // fast backoff: a transient failure must not
    // cost a full 4s tick (3 silent misses = the reported 12s stall).
    const load = async () => {
      try {
        const all = await api<ApiSessionSummary[]>('/sessions/tree');
        if (stopped) return;
        setConnError(false);
        retryMs = 500;
        // Dedup: identical topology/state must not rebuild the tree —
        // poll re-renders are pure waste. rootId is part of the
        // signature: the mount-time load runs with rootId='' (bootstrap
        // pending) and MUST NOT poison the marker for the real root.
        const sig = `${rootId ?? ''}#` + all.map(s => `${s.id}:${s.busy ? 1 : 0}`
          + `:${s.spawnName ?? ''}:${s.messages}:${s.title ?? ''}`).join('|');
        // R3: 去重签名接线——此前只写不读, 注释宣称的去重是死代码。
        if (sig === lastSig.current) return;

        lastSig.current = sig;
        setTree(buildTree(all, rootId ?? ''));
      } catch {
        if (stopped) return;
        setConnError(true);
        // R16-F5: 退避链上限 1——失败期 4s 轮询仍在触发, 每个 catch 各
        // 自派生一条 setTimeout 链会无界叠加(请求量随停机时长线性涨)。
        if (retryTimer.current === null) {
          const ms = retryMs;
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            if (!stopped) void load();
          }, ms);
        }
        retryMs = Math.min(retryMs * 2, 4000);
        return;
      }
    };
    void load();
    const timer = setInterval(load, 4000);
    return () => { stopped = true; clearInterval(timer); if (retryTimer.current) clearTimeout(retryTimer.current); };
  }, [rootId]);

  // F73: 全树递归计数——此前 1+children.length 漏计孙代及更深
  // (spawnMaxDepth=3 时 L2/L3 不入数, 头部计数与树体不一致)。
  const sizeOf = (n: { children: unknown[] }): number =>
    1 + n.children.reduce((acc: number, c) => acc + sizeOf(c as { children: unknown[] }), 0);
  const count = tree ? sizeOf(tree) : 0;

  return (
    <div className="animate-enter flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-surface shadow-xs">
      <header className="flex items-center justify-between border-b border-line bg-surface-2/50 px-3 py-1.5">
        <h3 className="text-[13px] font-semibold text-secondary">
          编排树
        </h3>
        <span className="text-xs tabular-nums text-tertiary">{count} 节点</span>
      </header>
      <div className="flex-1 overflow-y-auto p-1.5">
        {!tree && (
          connError
            ? <p className="animate-pulse py-3 text-center text-sm text-warning-text">连接中断，重试中…</p>
            : rootId
              ? <Skeleton className="m-1 h-11" />
              : <EmptyState icon={Bot} title="无主控会话" />
        )}
        {tree && (
          <Node node={tree} depth={0} activeId={activeId} onDrill={onDrill} />
        )}
      </div>
    </div>
  );
}
