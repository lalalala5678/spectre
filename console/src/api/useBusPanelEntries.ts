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

export type { FoldedEntry };


export function useBusPanelEntries(
  accept: (e: ApiBusEvent) => boolean,
  o?: { ws?: string; limit?: number },
): { events: FoldedEntry[]; loaded: boolean } {
  const { ws, limit = 20 } = o ?? {};
  const [events, setEvents] = useState<FoldedEntry[]>([]);
  // Distinguish LOADING (fetch in flight) from EMPTY (loaded, nothing
  // published) — stale content must never linger after a project switch,
  // and '暂无' must never flash first.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let stopped = false;
    const cursor = { v: 0 };
    setEvents([]);
    setLoaded(false);
    const snapshot = async () => {
      const all = await api<ApiBusEvent[]>('/bus' + (ws ? `?ws=${ws}` : ''));
      if (stopped) return;
      setEvents(foldEntries(all).filter(accept).slice(-limit).reverse());
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
