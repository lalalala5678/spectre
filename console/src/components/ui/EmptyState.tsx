import type { ComponentType, ReactNode } from 'react';

import { cn } from '../../utils/cn';

/** §5.6 EmptyState: 图标+标题+引导, 替换一行小灰字空态(D8)。
 * tone='chrome' 供深色壳内浮层(如顶栏铃铛下拉)——FEAESTH4-P2:
 * 浅色版在 chrome-surface 上呈 1.05:1 隐形。 */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  className,
  tone = 'surface',
}: {
  icon: ComponentType<{ className?: string }>;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
  tone?: 'surface' | 'chrome';
}) {
  const chrome = tone === 'chrome';
  return (
    <div className={cn('flex min-h-40 flex-col items-center justify-center gap-2 p-8 text-center', className)}>
      <span className={cn('flex h-10 w-10 items-center justify-center rounded-full',
        chrome ? 'bg-chrome-surface-2' : 'bg-surface-2')}>
        <Icon className={cn('h-5 w-5', chrome ? 'text-chrome-tertiary' : 'text-tertiary')} />
      </span>
      <p className={cn('text-sm font-medium', chrome ? 'text-chrome-primary' : 'text-primary')}>{title}</p>
      {hint && <p className={cn('max-w-sm text-[13px]', chrome ? 'text-chrome-tertiary' : 'text-tertiary')}>{hint}</p>}
      {action}
    </div>
  );
}
