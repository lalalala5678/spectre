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
      {(() => {
        /* 用户令(补全): 全部条目标注所属主控会话——含主控直发; 漏洞
         * 正本由 writer 会话发布(无上级链), 归属取 requester(发现者)
         * 的 treePath 首段——此前漏洞列表零标注正因 writer 单段链。 */
        const root = (event.requester?.treePath ?? a?.treePath ?? '').split(' › ')[0];
        if (!root) return null;
        return (
          <p className="truncate pl-1 text-xs leading-tight text-tertiary">
            <span className="text-accent-text/80">{root} · </span>
            {a?.name ?? event.requester?.name ?? ''}{a ? `（${a.typeLabel}${a.parent ? ` · 父:${a.parent.name}` : ''} · L${a.depth}）` : ''}
          </p>
        );
      })()}
    </>
  );
}
