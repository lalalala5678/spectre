import type { HTMLAttributes } from 'react';

import { cn } from '../../utils/cn';

/** §5.8 Kbd: 键盘提示(快捷键白名单 mono) */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn('rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-tertiary', className)}
      {...props}
    />
  );
}
