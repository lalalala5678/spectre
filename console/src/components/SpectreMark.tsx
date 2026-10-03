import { cn } from '../utils/cn';

/**
 * SPECTRE 品牌图标 — 自绘 SVG(§6.1-20 主题化)
 * 颜色全部注入 CSS 变量深色壳内恒深牌(currentColor 消费方定色):
 * 徽章底 surface-2 · 边界/连线 line-strong·tertiary · 准星 danger · 顶点节点 accent
 */
export function SpectreMark({ className }: { className?: string }) {
  // 六边形环上的节点位置（圆心 16,16，半径 10.5，起始 -90°）
  const cx = 16, cy = 16, r = 10.5;
  const nodes = Array.from({ length: 6 }, (_, i) => {
    const a = (-90 + i * 60) * (Math.PI / 180);
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), top: i === 0 };
  });

  return (
    <svg viewBox="0 0 32 32" className={cn('h-7 w-7', className)} aria-label="SPECTRE">
      {/* 徽章底：圆角六边形 */}
      <path
        d="M16 2.2 L28.3 9.3 V22.7 L16 29.8 L3.7 22.7 V9.3 Z"
        fill="var(--surface-2)"
        stroke="var(--line-strong)"
        strokeWidth="1"
      />
      {/* 节点间的编排连线（六边形环） */}
      {nodes.map((n, i) => {
        const m = nodes[(i + 1) % 6];
        return (
          <line key={i} x1={n.x} y1={n.y} x2={m.x} y2={m.y}
            stroke="var(--text-tertiary)" strokeWidth="0.8" opacity="0.7" />
        );
      })}
      {/* 准星刻度：上下左右 */}
      <g stroke="var(--danger-text)" strokeWidth="1.1">
        <line x1="16" y1="8.6" x2="16" y2="11.4" />
        <line x1="16" y1="20.6" x2="16" y2="23.4" />
        <line x1="8.6" y1="16" x2="11.4" y2="16" />
        <line x1="20.6" y1="16" x2="23.4" y2="16" />
      </g>
      {/* 准星内环 */}
      <circle cx="16" cy="16" r="4.6" fill="none" stroke="var(--danger-text)" strokeWidth="1.1" />
      {/* 核心命中点 */}
      <circle cx="16" cy="16" r="1.6" fill="var(--danger-text)" />
      {/* 编排节点：顶点 accent = orchestrator，其余 secondary */}
      {nodes.map((n, i) => (
        <circle key={i} cx={n.x} cy={n.y} r={n.top ? 2 : 1.5}
          fill={n.top ? 'var(--accent)' : 'var(--text-secondary)'} stroke="var(--surface-2)" strokeWidth="0.6" />
      ))}
    </svg>
  );
}
