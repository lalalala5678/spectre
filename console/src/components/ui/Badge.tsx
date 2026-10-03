import type { ReactNode } from 'react';

import { cn } from '../../utils/cn';

/** §5.5 语义徽章: 六 tone 三件套(替代手抄色表)。
 * severity 映射: critical/high→danger, medium→warning, low/info→info;
 * status: success→success, partial→warning, failed→danger, no-result→neutral。 */
const TONES = {
  neutral: 'border-line bg-surface-2 text-secondary',
  accent: 'border-line bg-accent-subtle text-accent-text',
  success: 'border-success-line bg-success-bg text-success-text',
  warning: 'border-warning-line bg-warning-bg text-warning-text',
  danger: 'border-danger-line bg-danger-bg text-danger-text',
  info: 'border-info-line bg-info-bg text-info-text',
} as const;

export type BadgeTone = keyof typeof TONES;

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums', TONES[tone], className)}>
      {children}
    </span>
  );
}

/** 状态色点(§5.5 语义名, 与 Badge 同一套六 tone):
 * busy/运行中→accent · 完成/就绪→info · 异常→danger · 告警→warning
 * · 成功→success · 空闲/无→neutral。旧色名别名已随调用方迁移删除。 */
const DOT = {
  accent: 'bg-accent',
  success: 'bg-success-text',
  warning: 'bg-warning-text',
  danger: 'bg-danger-text',
  info: 'bg-info-text',
  neutral: 'bg-faint',
} as const;

export type DotTone = keyof typeof DOT;

export function Dot({
  tone = 'neutral',
  pulse = false,
  className,
}: {
  tone?: DotTone;
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
