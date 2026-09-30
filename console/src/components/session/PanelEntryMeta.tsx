/**
 * PanelEntryMeta (CS3-N23): VulnPanel/TaskReportsPanel 两处 ~20 行逐字
 * 重复的条目元部件——⟳ 修订徽标 + 溯源行 + 已作废标。R18 曾只抽 ProvenanceLine
 * 的计划作废, 本组件覆盖整个尾块。
 */
import type { FoldedEntry } from '../../api/useBusPanelEntries';
import { ChevronRight } from 'lucide-react';

export function PanelEntryMeta({ event, voidable }: {
  event: FoldedEntry;
  /** TaskReports 有作废标; Vuln 用删除线(在标题处)不在此渲染。 */
  voidable?: boolean;
}) {
  const a = event.author;
  return (
    <>
      {voidable && event.current.void && (
        <span className="shrink-0 rounded-sm border border-void-600 px-1 py-0.5 font-mono text-[8.5px] text-zinc-600">已作废</span>
      )}
      {event.revisedCount > 0 && (
        <span className="shrink-0 rounded-sm border border-sky-800 bg-sky-950/40 px-1 py-0.5 font-mono text-[8.5px] tracking-widest text-sky-300">
          ⟳{event.revisedCount}
        </span>
      )}
      <ChevronRight className="h-3 w-3 shrink-0 text-zinc-600" />
      {a && (
        <p className="truncate pl-1 text-[10px] leading-tight text-zinc-600">
          {a.name}（{a.typeLabel}{a.parent ? ` · 父:${a.parent.name}` : ''} · L{a.depth}）
        </p>
      )}
    </>
  );
}

