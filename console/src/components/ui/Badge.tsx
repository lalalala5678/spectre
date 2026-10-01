import { cn } from '../../utils/cn';
import type { BadgeTone } from './badgeTones';
// CS42-F1: Badge 彩色标签组件(零消费者)已删——仅保留状态色点 Dot。

/** 状态色点：真实产品里最常用的状态表达方式 */
const DOT: Record<BadgeTone, string> = {
  green: 'bg-emerald-500',
  cyan: 'bg-zinc-400',
  red: 'bg-red-500',
  rose: 'bg-red-500',
  amber: 'bg-amber-500',
  blue: 'bg-sky-500',
  slate: 'bg-zinc-600',
  violet: 'bg-zinc-400',
  orange: 'bg-orange-500',
};

export function Dot({
  tone = 'slate',
  pulse = false,
  className,
}: {
  tone?: BadgeTone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('relative inline-flex h-1.5 w-1.5 shrink-0', className)}>
      {pulse && (
        <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', DOT[tone])} />
      )}
      <span className={cn('relative inline-flex h-1.5 w-1.5 rounded-full', DOT[tone])} />
    </span>
  );
}

