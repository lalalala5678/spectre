/**
 * useListboxNavigation — 下拉/搜索结果的键盘导航(↑↓ Home End Enter Esc)。
 *
 * 消费面: Topbar 搜索、项目切换器、主控会话切换器等纯鼠标 button 列表。
 * ARIA: 容器 role="listbox" + 子项 role="option" + aria-activedescendant。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export function useListboxNavigation(itemCount: number, onSelect: (index: number) => void, open: boolean) {
  const [activeIdx, setActiveIdx] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset when reopened or item count changes
  useEffect(() => {
    if (!open) setActiveIdx(-1);
  }, [open]);
  useEffect(() => {
    if (activeIdx >= itemCount) setActiveIdx(itemCount - 1);
  }, [itemCount, activeIdx]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open || itemCount === 0) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIdx(i => (i + 1) % itemCount);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIdx(i => (i <= 0 ? itemCount - 1 : i - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIdx(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIdx(itemCount - 1);
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIdx >= 0 && activeIdx < itemCount) onSelect(activeIdx);
        break;
      case 'Escape':
        e.preventDefault();
        setActiveIdx(-1);
        break;
    }
  }, [open, itemCount, activeIdx, onSelect]);

  // Scroll active item into view
  useEffect(() => {
    if (activeIdx < 0 || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${activeIdx}"]`);
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  return { activeIdx, setActiveIdx, onKeyDown, listRef };
}
