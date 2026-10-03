import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { getPrefs, putPrefsSync } from '../../api/worksession';

/**
 * SplitPane — 横向双栏可调分割(用户令 EQ-8: 所有分栏窗口宽度可调)。
 * 与 PanelStack 同协议: prefs 持久化(storageKey 隔离)+双击复位+min/max 夹取。
 * <xl(1280) 自动纵向堆叠(handle 隐藏)——窄屏自适应。
 */
export function SplitPane({ storageKey, initial = 0.62, min = 0.2, max = 0.8,
  children, className }: {
  storageKey: string;
  initial?: number;
  min?: number;
  max?: number;
  children: [ReactNode, ReactNode];
  className?: string;
}) {
  const [ratio, setRatio] = useState(initial);
  const [wide, setWide] = useState(() => window.innerWidth >= 1280);
  useEffect(() => {
    let cancelled = false;
    getPrefs().then(prefs => {
      if (cancelled) return;
      const saved = prefs.ui?.splitRatios?.[storageKey];
      if (typeof saved === 'number' && saved > min && saved < max) setRatio(saved);
    }).catch(() => { /* keep initial */ });
    return () => { cancelled = true; };
  }, [storageKey, min, max]);
  useEffect(() => {
    const mq = matchMedia('(min-width: 1280px)');
    const on = () => setWide(mq.matches);
    on(); mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; r: number; moved: boolean } | null>(null);
  const down = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, r: ratio, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [ratio]);
  const move = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const w = ref.current?.clientWidth ?? 0;
    if (w <= 0) return;
    const next = Math.min(max, Math.max(min, d.r + (e.clientX - d.x) / w));
    if (Math.abs(next - d.r) > 0.002) d.moved = true;
    setRatio(next);
  }, [min, max]);
  const up = useCallback(() => {
    if (drag.current?.moved) void putPrefsSync({ ui: { splitRatios: { [storageKey]: ratio } } });
    drag.current = null;
  }, [storageKey, ratio]);
  const reset = useCallback(() => {
    setRatio(initial);
    void putPrefsSync({ ui: { splitRatios: { [storageKey]: initial } } });
  }, [storageKey, initial]);

  return (
    <div ref={ref} className={className ?? 'flex h-full min-h-0 w-full flex-col gap-3 xl:flex-row'}>
      {/* 左栏: 宽屏按 ratio, 窄屏满宽堆叠 */}
      <div className="min-h-0 min-w-0 xl:shrink-0" style={wide ? { width: `${(ratio * 100).toFixed(2)}%` } : undefined}>
        <div className="h-full min-h-0 overflow-auto">{children[0]}</div>
      </div>
      <div
        role="separator" aria-orientation="vertical" tabIndex={0}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onDoubleClick={reset}
        onKeyDown={e => {
          if (e.key === 'ArrowLeft') { setRatio(r => Math.max(min, r - 0.03)); e.preventDefault(); }
          if (e.key === 'ArrowRight') { setRatio(r => Math.min(max, r + 0.03)); e.preventDefault(); }
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            void putPrefsSync({ ui: { splitRatios: { [storageKey]: ratio } } });
          }
        }}
        title="拖动调整宽度 · 双击恢复默认 · 聚焦后可用左右方向键微调"
        className="group hidden w-1.5 shrink-0 cursor-col-resize rounded-full bg-line transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring xl:block"
      >
        <span className="mx-auto block h-8 w-0.5 rounded-full bg-line-strong opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children[1]}</div>
    </div>
  );
}
