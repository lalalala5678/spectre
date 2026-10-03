import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api } from '../api/client';
import type { ApiBusEvent } from '../api/client';
import { Badge, Dot } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { SplitPane } from '../components/ui/SplitPane';
import { Panel } from '../components/ui/Panel';
import { Skeleton } from '../components/ui/Skeleton';
import { usePageTitle } from '../utils/usePageTitle';

/** 审计与证据链页 —— F23: 原为 mock 假数据,接真实 bus 事件流(WAL 持久审计源) */
// CS67-5: 类型复用 ApiBusEvent 单源(此前手抄窄版且 to?/engagement?
// 两死字段零读取——违 CS44-F16 手抄类型先例)。

export function AuditPage() {
  usePageTitle('审计与证据链'); // FEVERIFY-N3
  const [events, setEvents] = useState<ApiBusEvent[] | null>(null);
  const [err, setErr] = useState('');
  const [limit, setLimit] = useState(50);
  const [exportTick, setExportTick] = useState(0);

  useEffect(() => {
    api<ApiBusEvent[]>('/bus')
      .then(all => setEvents([...all].reverse()))
      .catch(e => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (exportTick === 0) return;
    const text = JSON.stringify(events ?? [], null, 1);
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `spectre-audit-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);  // FEVERIFY2-N2-2(真修)
  // 导出动作读当时的 events 快照, 不需要在 events 变化时重触发
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportTick]);

  const shown = (events ?? []).slice(0, limit);

  return (
    <SplitPane storageKey="spectre.split.audit" initial={0.66} className="flex h-full min-h-0 w-full flex-col gap-3 xl:flex-row">
      <Panel
        title="操作审计链(总线事件,新→旧)"
        className="h-full min-h-0"
        bodyClassName="flex min-h-0 flex-col p-0"
      >
        <div className="flex shrink-0 justify-end px-3 pt-2.5">
          <Button variant="secondary" size="sm" onClick={() => setExportTick(t => t + 1)}>
            <Download className="h-3.5 w-3.5" /> 导出 JSON
          </Button>
</div>
        {err ? <div className="px-3 py-4 text-[13px] text-danger-text">加载失败:{err}</div>
          : !events ? <div className="space-y-2 p-3">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-2/3" />
          </div>
          : events.length === 0 ? <EmptyState icon={Download} title="暂无审计事件" hint="总线事件将在此实时列出" className="flex-1" />
          : <>
          <div className="min-h-0 flex-1 overflow-auto"><table className="w-full text-left">
          <thead>
            <tr className="text-xs font-medium text-tertiary">
              <th className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2 text-right">Seq</th>
              <th className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2">时间</th>
              <th className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2">Actor</th>
              <th className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2">通道</th>
              <th className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2">摘要</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((r) => (
              <tr key={r.seq} className="odd:bg-surface-2/50 hover:bg-surface-2">
                <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-tertiary">#{r.seq}</td>
                <td className="px-3 py-2.5 font-mono text-xs tabular-nums text-tertiary">{r.ts?.slice(5, 19).replace('T', ' ')}</td>
                <td className="px-3 py-2.5">
                  <span className={`font-mono text-xs tabular-nums ${r.from === 'user' || r.from === 'orchestrator' ? 'text-accent-text' : 'text-secondary'}`}>{r.from}</span>
                </td>
                <td className="px-3 py-2.5"><Badge tone="neutral">{r.channel}{r.type ? `:${r.type}` : ''}</Badge></td>
                <td className="max-w-[420px] truncate px-3 py-2.5 text-[13px] text-secondary" title={r.summary}>{r.summary}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {events.length > limit && (
          <Button variant="secondary" size="sm" className="m-3 shrink-0 self-start" onClick={() => setLimit(l => l + 100)}>
            加载更多({shown.length}/{events.length})
          </Button>
        )}
        </>
        }
      </Panel>

      <div className="space-y-3">
        <Panel title="审计链完整性">
          <div className="space-y-2 text-[13px] text-secondary">
            <div className="flex justify-between"><span>总线事件总量</span><span className="font-mono text-xs tabular-nums text-primary">{events?.length ?? '…'}</span></div>
            <div className="flex justify-between"><span>WAL 持久化</span><span className="flex items-center gap-1 font-mono text-xs text-primary"><Dot tone="info" />state.wal</span></div>
            <div className="flex justify-between"><span>journal 上限</span><span className="font-mono text-xs text-primary">5000 事件(滚动)</span></div>
            <div className="flex justify-between"><span>数据来源</span><span className="font-mono text-xs text-primary">GET /api/bus(实时)</span></div>
          </div>
        </Panel>
        <Panel title="导出说明">
          <div className="space-y-2 text-[13px] leading-relaxed text-tertiary">
            导出内容为最近 5000 条操作记录(超出后最旧的自动滚出);修订与审批
            信息都包含在每条记录内。历史记录只追加、不可改写。
          </div>
        </Panel>
      </div>
    </SplitPane>
  );
}
