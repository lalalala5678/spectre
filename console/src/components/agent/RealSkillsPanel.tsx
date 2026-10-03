/** RealSkillsPanel — F24 真实技能只读面板; CS44-F17 拆出。 */
import { useEffect, useState } from 'react';
import { cn } from '../../utils/cn';
import { api } from '../../api/client';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { Dot } from '../ui/Badge';
import { Skeleton } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';

/** F24: 真实技能只读面板(原 mock 假技能名列表) */
export function RealSkillsPanel({ agentKey, expandable = false }: { agentKey: string; expandable?: boolean }) {
  const [names, setNames] = useState<string[] | null>(null);
  const [err, setErr] = useState('');
  // R32D44-feature: 点击技能直接看正文(展开态缓存, 再点收起)
  const [open, setOpen] = useState<string | null>(null);
  const [content, setContent] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState('');

  useEffect(() => {
    api<{ agentKey: string; name: string }[]>('/sandbox/skills')
      .then(tree => {
        setNames(tree.filter(t => t.agentKey === agentKey).map(t => t.name));
      })
      .catch(e => setErr(e instanceof Error ? e.message : String(e)));
  }, [agentKey]);

  const toggle = async (n: string) => {
    if (open === n) { setOpen(null); return; }
    setOpen(n);
    if (content[n] === undefined) {
      setLoading(n);
      try {
        const r = await api<{ content: string }>(`/sandbox/skills/content?agentKey=${encodeURIComponent(agentKey)}&name=${encodeURIComponent(n)}`);
        setContent(c => ({ ...c, [n]: r.content }));
      } catch (e) {
        setContent(c => ({ ...c, [n]: `加载失败: ${e instanceof Error ? e.message : String(e)}` }));
      } finally {
        setLoading('');
      }
    }
  };

  if (err) return <div className="text-[13px] text-danger-text">加载失败:{err}</div>;
  if (!names) return <div className="space-y-1.5">
    <Skeleton className="h-8 w-full" />
    <Skeleton className="h-8 w-full" />
  </div>;
  if (!names.length) return <EmptyState icon={FileText} title="该 agent 暂无挂载技能" />;
  return (
    <div className="space-y-1.5">
      {names.map(n => (
        <div key={n} className="min-w-0 rounded-md border border-line bg-surface">
          <button
            onClick={expandable ? () => void toggle(n) : undefined}
            className={cn('flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left', expandable && 'hover:bg-surface-2/60')}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {expandable && (open === n
                ? <ChevronDown className="h-3 w-3 shrink-0 text-tertiary" />
                : <ChevronRight className="h-3 w-3 shrink-0 text-tertiary" />)}
              <span className="truncate font-mono text-[13px] text-secondary">#{n}</span>
            </span>
            <Dot tone="info" />
          </button>
          {expandable && open === n && (
            <div className="border-t border-line px-2.5 py-2">
              {loading === n && content[n] === undefined
                ? <Skeleton className="h-16 w-full" />
                : <pre className="max-h-80 w-full min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg p-2 font-mono text-[13px] leading-relaxed text-secondary">{content[n]}</pre>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
