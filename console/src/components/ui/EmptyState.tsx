import type { ComponentType, ReactNode } from 'react';

import { cn } from '../../utils/cn';

/** §5.6 EmptyState: 图标+标题+引导, 替换一行小灰字空态(D8) */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-h-40 flex-col items-center justify-center gap-2 p-8 text-center', className)}>
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-2">
        <Icon className="h-5 w-5 text-tertiary" />
      </span>
      <p className="text-sm font-medium text-primary">{title}</p>
      {hint && <p className="max-w-sm text-[13px] text-tertiary">{hint}</p>}
      {action}
    </div>
  );
}
