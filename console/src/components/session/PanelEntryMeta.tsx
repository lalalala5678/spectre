/**
 * PanelEntryMeta (CS3-N23): VulnPanel/TaskReportsPanel 两处 ~20 行逐字
 * 重复的条目元部件——⟳ 修订徽标 + 溯源行 + 已作废标。R18 曾只抽 ProvenanceLine
 * 的计划作废, 本组件覆盖整个尾块。
 */
import type { FoldedEntry } from '../../api/useBusPanelEntries';
import { Badge } from '../ui/Badge';
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
        <Badge tone="neutral" className="shrink-0 line-through">已作废</Badge>
      )}
      {event.revisedCount > 0 && (
        <Badge tone="info" className="shrink-0 tabular-nums">
          ⟳{event.revisedCount}
        </Badge>
      )}
      <ChevronRight className="h-3 w-3 shrink-0 text-tertiary" />
      {a && (
        <p className="truncate pl-1 text-xs leading-tight text-tertiary">
          {a.name}（{a.typeLabel}{a.parent ? ` · 父:${a.parent.name}` : ''} · L{a.depth}）
        </p>
      )}
    </>
  );
}
