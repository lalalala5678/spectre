import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { api } from '../api/client';
import type { ApiBusEvent } from '../api/client';
import { Dot } from '../components/ui/Badge';
import { Panel } from '../components/ui/Panel';

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
        <div className="mb-2 flex justify-end">
          <button
            onClick={() => setExportTick(t => t + 1)}
            className="flex items-center gap-1 rounded-sm border border-void-600 bg-void-800 px-2 py-1 text-[11px] text-zinc-400 hover:bg-void-700">
            <Download className="h-3 w-3" /> 导出 JSON
          </button>
</div>
        {err ? <div className="px-3 py-4 text-[11.5px] text-red-400">加载失败:{err}</div>
          : !events ? <div className="flex items-center gap-2 px-3 py-4 text-[11.5px] text-zinc-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />载入中…</div>
          : <table className="w-full text-left">
          <thead>
            <tr className="border-b border-void-700 text-[10px] uppercase tracking-wider text-zinc-600">
              <th className="px-3 py-2 font-semibold">Seq</th>
              <th className="px-3 py-2 font-semibold">时间</th>
              <th className="px-3 py-2 font-semibold">Actor</th>
              <th className="px-3 py-2 font-semibold">通道</th>
              <th className="px-3 py-2 font-semibold">摘要</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-void-700">
            {shown.map((r) => (
              <tr key={r.seq} className="hover:bg-void-800/60">
                <td className="px-3 py-2 font-mono text-[11px] text-zinc-600">#{r.seq}</td>
                <td className="px-3 py-2 font-mono text-[11px] text-zinc-600">{r.ts?.slice(5, 19).replace('T', ' ')}</td>
                <td className="px-3 py-2">
                  <span className={`font-mono text-[11px] ${r.from === 'user' || r.from === 'orchestrator' ? 'text-orange-300' : 'text-zinc-400'}`}>{r.from}</span>
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-zinc-300">{r.channel}{r.type ? `:${r.type}` : ''}</td>
                <td className="max-w-[420px] truncate px-3 py-2 text-[11.5px] text-zinc-500" title={r.summary}>{r.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>}
        {events && events.length > limit && (
          <button onClick={() => setLimit(l => l + 100)}
            className="w-full border-t border-void-700 py-2 text-[11px] text-zinc-500 hover:text-zinc-300">
            加载更多({shown.length}/{events.length})
          </button>
        )}
      </Panel>

      <div className="space-y-3">
        <Panel title="审计链完整性">
          <div className="space-y-2 text-[11.5px] text-zinc-500">
            <div className="flex justify-between"><span>总线事件总量</span><span className="font-mono text-zinc-300">{events?.length ?? '…'}</span></div>
            <div className="flex justify-between"><span>WAL 持久化</span><span className="flex items-center gap-1 font-mono text-zinc-300"><Dot tone="cyan" />state.wal</span></div>
            <div className="flex justify-between"><span>journal 上限</span><span className="font-mono text-zinc-300">5000 事件(滚动)</span></div>
            <div className="flex justify-between"><span>数据来源</span><span className="font-mono text-zinc-300">GET /api/bus(实时)</span></div>
          </div>
        </Panel>
        <Panel title="导出说明">
          <div className="space-y-2 text-[11.5px] leading-relaxed text-zinc-500">
            审计导出为内存 journal 最近 5000 条(滚动上限,seq 单调);修订链(revises/revision)
            与审批流(origin/requestedBy)字段均在事件内。签名/Merkle 属后续
            增强,当前以 WAL 追加语义保证不可改写历史。
          </div>
        </Panel>
      </div>
    </div>
  );
}
