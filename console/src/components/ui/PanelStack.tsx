import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';

import { getPrefs, putPrefsSync } from '../../api/worksession';

/**
 * Vertical panel stack with draggable dividers: each child gets a share of
 * the column height, adjusted by dragging the divider between panels. No
 * artificial limits — a panel can shrink to a sliver or take the column;
 * only a 1% floor keeps the divider itself grabbable. Shares persist per
 * storage key; double-clicking a divider restores an even split.
 */
const DIVIDER_PX = 6;

export function PanelStack({ storageKey, children }: {
  storageKey: string;
  children: ReactNode[];
}) {
  const n = children.length;
  const stackRef = useRef<HTMLDivElement>(null);
  // Server-side persistence (prefs.ui.stackRatios[storageKey]) — the
  // browser keeps nothing. Loads async; even split until then.
  const [ratios, setRatios] = useState<number[]>(() => Array(n).fill(1 / n));
  useEffect(() => {
    let cancelled = false;
    getPrefs().then(prefs => {
      if (cancelled) return;
      const saved = prefs.ui?.stackRatios?.[storageKey];
      if (Array.isArray(saved) && saved.length === n
        && saved.every((v: number) => v > 0 && v < 1)
        && Math.abs(saved.reduce((a: number, b: number) => a + b, 0) - 1) < 0.02) {
        setRatios(saved);
      }
    }).catch(() => { /* even split stays */ });
    return () => { cancelled = true; };
  }, [storageKey, n]);
  const drag = useRef<{ i: number; startY: number; a: number; b: number; moved: boolean } | null>(null);

  const dividerDown = (e: React.PointerEvent<HTMLDivElement>, i: number) => {
    drag.current = { i, startY: e.clientY, a: ratios[i], b: ratios[i + 1], moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const dividerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const usable = (stackRef.current?.clientHeight ?? 0) - (n - 1) * DIVIDER_PX;
    const delta = usable > 0 ? (e.clientY - d.startY) / usable : 0;
    if (!d.moved && Math.abs(delta) < 0.005) return;
    d.moved = true;
    setRatios(prev => {
      const pair = d.a + d.b;
      const next = [...prev];
      next[d.i] = Math.min(pair - 0.01, Math.max(0.01, d.a + delta));
      next[d.i + 1] = pair - next[d.i];
      return next;
    });
  };
  const dividerUp = () => {
    if (drag.current?.moved) {
      void putPrefsSync({ ui: { stackRatios: { [storageKey]: ratios } } });
    }
    drag.current = null;
  };
  const evenSplit = () => {
    void putPrefsSync({ ui: { stackRatios: { [storageKey]: null } } });
    setRatios(Array(n).fill(1 / n));
  };

  return (
    <div ref={stackRef} className="flex h-full min-h-0 flex-col">
      {children.map((child, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <div
              onPointerDown={e => dividerDown(e, i - 1)}
              onPointerMove={dividerMove}
              onPointerUp={dividerUp}
          onPointerCancel={dividerUp}
          onLostPointerCapture={dividerUp}
              onDoubleClick={evenSplit}
              title="拖动调整高度 · 双击均分"
              className="relative z-10 h-1.5 shrink-0 cursor-row-resize after:absolute after:left-0 after:top-1/2 after:h-px after:w-full after:-translate-y-1/2 after:bg-line after:transition-colors hover:after:bg-accent"
            />
          )}
          <div
            className="flex min-h-0 flex-col"
            style={{ flex: `0 0 calc((100% - ${(n - 1) * DIVIDER_PX}px) * ${ratios[i]})` }}
          >
            {child}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
