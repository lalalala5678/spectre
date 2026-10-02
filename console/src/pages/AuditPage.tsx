import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api } from '../api/client';
import type { ApiBusEvent } from '../api/client';
import { Badge, Dot } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { Panel } from '../components/ui/Panel';
import { Skeleton } from '../components/ui/Skeleton';

/** 审计与证据链页 —— F23: 原为 mock 假数据,接真实 bus 事件流(WAL 持久审计源) */
// CS67-5: 类型复用 ApiBusEvent 单源(此前手抄窄版且 to?/engagement?
// 两死字段零读取——违 CS44-F16 手抄类型先例)。

export function AuditPage() {
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
    a.href = URL.createObjectURL(blob);
    a.download = `spectre-audit-${Date.now()}.json`;
    a.click();
  // 导出动作读当时的 events 快照, 不需要在 events 变化时重触发
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportTick]);

  const shown = (events ?? []).slice(0, limit);

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
      <Panel
        title="操作审计链(总线事件,新→旧)"
        className="xl:col-span-2"
        bodyClassName="p-0"
      >
        <div className="mb-2 flex justify-end px-3 pt-1">
          <Button variant="secondary" size="sm" onClick={() => setExportTick(t => t + 1)}>
            <Download className="h-3 w-3" /> 导出 JSON
          </Button>
</div>
        {err ? <div className="px-3 py-4 text-[13px] text-danger-text">加载失败:{err}</div>
          : !events ? <div className="space-y-2 p-3">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-2/3" />
          </div>
          : events.length === 0 ? <EmptyState icon={Download} title="暂无审计事件" hint="总线事件将在此实时列出" />
          : <table className="w-full text-left">
          <thead>
            <tr className="border-b border-line text-xs font-medium text-tertiary">
              <th className="px-3 py-2.5">Seq</th>
              <th className="px-3 py-2.5">时间</th>
              <th className="px-3 py-2.5">Actor</th>
              <th className="px-3 py-2.5">通道</th>
              <th className="px-3 py-2.5">摘要</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((r) => (
              <tr key={r.seq} className="hover:bg-surface-2/60">
                <td className="px-3 py-2.5 font-mono text-xs tabular-nums text-tertiary">#{r.seq}</td>
                <td className="px-3 py-2.5 font-mono text-xs tabular-nums text-tertiary">{r.ts?.slice(5, 19).replace('T', ' ')}</td>
                <td className="px-3 py-2.5">
                  <span className={`font-mono text-xs tabular-nums ${r.from === 'user' || r.from === 'orchestrator' ? 'text-accent-text' : 'text-secondary'}`}>{r.from}</span>
                </td>
                <td className="px-3 py-2.5"><Badge tone="neutral">{r.channel}{r.type ? `:${r.type}` : ''}</Badge></td>
                <td className="max-w-[420px] truncate px-3 py-2.5 text-[13px] text-secondary" title={r.summary}>{r.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>}
        {events && events.length > limit && (
          <Button variant="secondary" size="sm" className="m-3" onClick={() => setLimit(l => l + 100)}>
            加载更多({shown.length}/{events.length})
          </Button>
        )}
      </Panel>

      <div className="space-y-3">
        <Panel title="审计链完整性">
          <div className="space-y-2 text-[13px] text-secondary">
            <div className="flex justify-between"><span>总线事件总量</span><span className="font-mono text-xs tabular-nums text-primary">{events?.length ?? '…'}</span></div>
            <div className="flex justify-between"><span>WAL 持久化</span><span className="flex items-center gap-1 font-mono text-xs text-primary"><Dot tone="cyan" />state.wal</span></div>
            <div className="flex justify-between"><span>journal 上限</span><span className="font-mono text-xs text-primary">5000 事件(滚动)</span></div>
            <div className="flex justify-between"><span>数据来源</span><span className="font-mono text-xs text-primary">GET /api/bus(实时)</span></div>
          </div>
        </Panel>
        <Panel title="导出说明">
          <div className="space-y-2 text-[13px] leading-relaxed text-tertiary">
            审计导出为内存 journal 最近 5000 条(滚动上限,seq 单调);修订链(revises/revision)
            与审批流(origin/requestedBy)字段均在事件内。签名/Merkle 属后续
            增强,当前以 WAL 追加语义保证不可改写历史。
          </div>
        </Panel>
      </div>
    </div>
  );
}
