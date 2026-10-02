import { cn } from '../../utils/cn';

/** §5.7 Skeleton: 骨架屏, 替换 animate-pulse 文本加载态(D8) */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-surface-2', className)} />;
}
