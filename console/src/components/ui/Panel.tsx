import { cn } from '../../utils/cn';

/** §5.2 Panel: 卡片/面板统一外壳——rounded-lg + surface 底 + xs 阴影(浅)/
 * 边界分层(暗), 标题 14px 句首大写(删 uppercase/tracking, D1/D3 治理)。 */
export function Panel({
  title,
  right,
  children,
  className,
  bodyClassName,
}: {
  title?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('animate-enter flex flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-xs', className)}>
      {title && (
        <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line bg-surface-2/50 px-4">
          <h3 className="truncate text-sm font-semibold text-primary">{title}</h3>
          {right}
        </header>
      )}
      <div className={cn('min-h-0 flex-1 p-4', bodyClassName)}>{children}</div>
    </section>
  );
}
