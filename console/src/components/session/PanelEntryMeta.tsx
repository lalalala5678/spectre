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
    /* 用户令: 窄屏标题优先——meta 收缩优先级高于标题(basis auto +
       shrink, 标题 flex-1), 溯源行窄时截断而非挤掉标题。 */
    <div className="flex min-w-0 shrink items-center gap-1">
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
        // 系统事件(运行时重启/看门狗)不属任何主控会话——标注"平台系统"
        // 而非留空(用户令: 每条都须有归属)。
        const label = root || (a && a.key === 'system' ? '平台系统' : '');
        if (!label) return null;
        return (
          <p className="truncate pl-1 text-xs leading-tight text-tertiary">
            <span className="text-accent-text/80">{label} · </span>
            {a?.name ?? event.requester?.name ?? ''}{a ? `（${a.typeLabel}${a.parent ? ` · 父:${a.parent.name}` : ''} · L${a.depth}）` : ''}
          </p>
        );
      })()}
    </div>
  );
}
