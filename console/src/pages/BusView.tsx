import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Megaphone } from 'lucide-react';
import { api, subscribeBus, type ApiBusEvent } from '../api/client';
import type { MessageChannel } from '../types';
import { Panel } from '../components/ui/Panel';
import { cn } from '../utils/cn';

const CH_META: Record<string, { label: string; cls: string }> = {
  announce: { label: '公告', cls: 'border-red-900 text-red-400' },
  dm: { label: '私信', cls: 'border-void-500 text-zinc-500' },
  share: { label: '共享', cls: 'border-orange-900 text-orange-400' },
};

/** R3-6: 未映射频道此前 chMeta(m.channel).cls 直接 TypeError——整个
 * 应用白屏(实测: journal 一条 channel='r2t' 测试事件即触发)。
 * 未知频道回退中性样式, 任何频道值都必须可渲染。 */
const chMeta = (c: string) => CH_META[c] ?? { label: c, cls: 'border-void-600 text-zinc-400' };

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
};

/** 消息总线视图:跨智能体实时流量(Temporal 编排驱动),按频道筛选 */
export function BusView({ workSessionId }: { workSessionId: string }) {
  const [filter, setFilter] = useState<MessageChannel | 'all'>('all');
  const [events, setEvents] = useState<ApiBusEvent[]>([]);
  const cursor = useRef(0);

  const [connError, setConnError] = useState('');

  // Replay history, then attach the live SSE stream.
  // R3-2: workSessionId 进依赖——切换项目必须重取快照(旧 deps [] 换项目
  // 后旧快照滞留+SSE 闭包持旧 id, 新项目事件全丢)。
  // R3-3: 失败不再空吞——connError+15s 退避重试; 订阅先行+since 尾拉
  // 消除'快照→订阅'间隙丢事件。
  useEffect(() => {
    let cancelled = false;
    let off = () => {};
    const run = async () => {
      try {
        const history = await api<ApiBusEvent[]>('/bus'
          + (workSessionId ? `?ws=${workSessionId}` : ''));
        if (cancelled) return;
        const seen = new Set<number>();
        const myWs = workSessionId;
        off = subscribeBus((name, raw) => {
          if (name !== 'bus') return;
          const ev = raw as ApiBusEvent;
          if (ev.workSessionId !== myWs || seen.has(ev.seq)) return;
          seen.add(ev.seq);
          setEvents((prev) => {
            const next = prev.concat(ev);
            return next.length > 500 ? next.slice(next.length - 500) : next;
          });
        });
        const mine = history.filter(e => e.workSessionId === myWs);
        setEvents(mine);
        for (const e of mine) seen.add(e.seq);
        cursor.current = history.at(-1)?.seq ?? 0;
        if (cursor.current > 0) {
          const tail = await api<ApiBusEvent[]>(`/bus?since=${cursor.current}`
            + (workSessionId ? `&ws=${workSessionId}` : ''));
          if (!cancelled) {
            for (const ev of tail) {
              if (ev.workSessionId !== myWs || seen.has(ev.seq)) continue;
              seen.add(ev.seq);
              setEvents(prev => prev.concat(ev));
            }
          }
        }
        if (!cancelled) { setConnError(''); }
      } catch (e) {
        if (!cancelled) setConnError(e instanceof Error ? e.message : String(e));
      }
    };
    void run();
    const retry = connError !== '' ? setInterval(() => { if (!cancelled) void run(); }, 15_000) : 0;
    return () => { cancelled = true; off(); if (retry) clearInterval(retry); };
  }, [workSessionId, connError]);

  const list = events
    .filter((m) => filter === 'all' || m.channel === filter)
    .slice()
    .reverse(); // newest first

  const counts = {
    all: events.length,
    announce: events.filter((m) => m.channel === 'announce').length,
    dm: events.filter((m) => m.channel === 'dm').length,
    share: events.filter((m) => m.channel === 'share').length,
  };

  return (
    <Panel
      title="消息总线 · agent 间信息传递"
      right={
        <div className="flex items-center gap-1">
          {(['all', 'announce', 'dm', 'share'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={cn(
                'rounded-sm px-2 py-0.5 text-[10px] transition-colors',
                filter === k
                  ? 'bg-void-700 text-zinc-200'
                  : 'text-zinc-600 hover:text-zinc-400',
              )}
            >
              {k === 'all' ? '全部' : CH_META[k].label}
              <span className="ml-1 font-mono text-[9px] text-zinc-600">{counts[k]}</span>
            </button>
          ))}
        </div>
      }
      bodyClassName="p-0"
      className="w-full"
    >
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-void-700 text-[10px] uppercase tracking-wider text-zinc-600">
            <th className="px-3 py-2 font-semibold">时间</th>
            <th className="px-3 py-2 font-semibold">频道</th>
            <th className="px-3 py-2 font-semibold">传递</th>
            <th className="px-3 py-2 font-semibold">类型</th>
            <th className="px-3 py-2 font-semibold">内容摘要</th>
            <th className="px-3 py-2 font-semibold">引用</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-void-700">
          {list.map((m) => (
            <tr key={m.seq} className={cn('hover:bg-void-800/60', m.channel === 'announce' && 'bg-red-950/5')}>
              <td className="px-3 py-2.5 font-mono text-[11px] text-zinc-600">{fmtTime(m.ts)}</td>
              <td className="px-3 py-2.5">
                <span className={cn('inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px]', chMeta(m.channel).cls)}>
                  {m.channel === 'announce' && <Megaphone className="h-2.5 w-2.5" />}
                  {chMeta(m.channel).label}
                </span>
              </td>
              <td className="px-3 py-2.5">
                <span className="flex items-center gap-1.5 font-mono text-[11.5px]">
                  <span className="text-zinc-300">{m.from}</span>
                  <ArrowRight className="h-3 w-3 text-zinc-600" />
                  <span className="text-zinc-300">{m.to}</span>
                </span>
              </td>
              <td className="px-3 py-2.5">
                <span className={cn(
                  'rounded-sm px-1.5 py-0.5 font-mono text-[10px]',
                  m.type === 'handoff' ? 'bg-orange-950/50 text-orange-400' : 'bg-void-700 text-zinc-400',
                )}>
                  {m.type}
                </span>
              </td>
              <td className="px-3 py-2.5">
                <span className="text-[11.5px] text-zinc-400">{m.summary}</span>
              </td>
              <td className="px-3 py-2.5">
                {m.payloadRef
                  ? <code className="rounded-sm bg-void-950 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">{m.payloadRef}</code>
                  : <span className="text-[10px] text-zinc-700">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-void-700 px-3 py-2 text-[10.5px] leading-relaxed text-zinc-600">
        公告 = 主控 → 全员(范围/约束变更);私信 = 点对点调度与回报;共享 = 情报广播(凭据/攻击面)。
        事件源:Temporal 编排信号 → 消息总线 journal · SSE 实时推送。
      </div>
    </Panel>
  );
}
