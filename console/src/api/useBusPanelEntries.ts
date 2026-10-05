/**
 * useBusPanelEntries (CS1-R1/R11): Vuln/IntelNotes/TaskReports 三面板的
 * SSE 同步块——快照(先折后滤) + 实时(修订重取/增量去重) + LOADING/EMPTY
 * 区分 + 项目切换竞态守卫。三处 ~45 行逐字重复收敛于此。
 *
 * R3-1: 先折后滤——accept 判 ORIGINAL 身份(origin/from), 修订事件在折
 * 后才被剔除; 先滤后折会把修订全部剥掉, 面板永久显示旧 title/severity。
 * R20-F2: stopped 守卫——旧项目在途 refetch 不得覆盖新项目清场。
 */
import { useEffect, useState } from 'react';
import { api, foldEntries, subscribeBus, type ApiBusEvent, type FoldedEntry } from './client';

export type { FoldedEntry };  // CS3-N23: PanelEntryMeta 消费


export function useBusPanelEntries(
  accept: (e: ApiBusEvent) => boolean,
  o?: { ws?: string; limit?: number },
): { events: FoldedEntry[]; loaded: boolean } {
  // 用户令(改判): 默认全量(不再截 20)——渲染侧用 content-visibility
  // 跳过屏外条目, 700+ 条不卡; o.limit 仅显式传入时生效。
  const { ws, limit } = o ?? {};
  const [events, setEvents] = useState<FoldedEntry[]>([]);
  // Distinguish LOADING (fetch in flight) from EMPTY (loaded, nothing
  // published) — stale content must never linger after a project switch,
  // and '暂无' must never flash first.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // r50i: ws 未就绪(空串/undefined)不请求——带错参查询返回空+loaded
    // 曾致"暂无漏洞/情报"闪现(切页/项目瞬间); 就绪后 effect 重跑拉真数据。
    if (!ws) { setEvents([]); setLoaded(false); return; }
    let stopped = false;
    const cursor = { v: 0 };
    setEvents([]);
    setLoaded(false);
    const snapshot = async (retry = true) => {
      const all = await api<ApiBusEvent[]>(`/bus?ws=${ws}`);
      if (stopped) return;
      const folded = foldEntries(all).filter(accept);
      // r50i: 空结果一次免费重试(瞬时竞态不落"暂无"态)
      if (folded.length === 0 && retry) {
        await new Promise(r => setTimeout(r, 350));
        if (!stopped) return snapshot(false);
      }
      setEvents(limit ? folded.slice(-limit).reverse() : folded.reverse());
      setLoaded(true);
      cursor.v = all.at(-1)?.seq ?? 0;
    };
    (async () => {
      try { await snapshot(); } catch { /* SSE reconnect will heal */ }
    })();
    const off = subscribeBus((name, raw) => {
      if (name !== 'bus') return;
      const e = raw as ApiBusEvent;
      if (e.seq <= cursor.v) return;
      cursor.v = e.seq;
      if (e.revises) {
        // revision landed — refetch to fold the new current version
        void (async () => {
          try { await snapshot(); } catch { /* next event heals */ }
        })();
        return;
      }
      if (!accept(e)) return;
      // seq-guard: snapshot + SSE replay overlap must not duplicate
      setEvents(prev => prev.some(x => x.seq === e.seq)
        ? prev
        : [{ ...e, current: e, revisedCount: 0 } as FoldedEntry, ...prev].slice(0, limit));
    });
    return () => { stopped = true; off(); };
  }, [ws, limit]);  // eslint-disable-line react-hooks/exhaustive-deps -- accept 是调用方每次渲染的闭包; 面板语义要求 ws 变化即重置, accept 内部读的是 props 同步值
  return { events, loaded };
}
