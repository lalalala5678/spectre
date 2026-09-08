import { cn } from '../../utils/cn';

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
    <section className={cn('rounded border border-void-700 bg-void-850', className)}>
      {title && (
        <header className="flex items-center justify-between gap-2 border-b border-void-700 px-3 py-1.5">
          <h3 className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">{title}</h3>
          {right}
        </header>
      )}
      <div className={cn('p-3', bodyClassName)}>{children}</div>
    </section>
  );
}
