import { cn } from '../../utils/cn';

export type BadgeTone =
  | 'green' | 'cyan' | 'red' | 'rose' | 'amber' | 'blue' | 'slate' | 'violet' | 'orange';

/**
 * 朴素标签：统一灰底细边，仅文本着色。
 * 彩色只留给真正需要区分的语义（severity / 审批），其余一律灰。
 */
const TONE: Record<BadgeTone, string> = {
  green: 'text-emerald-400/80',
  cyan: 'text-zinc-300',
  red: 'text-red-400/90',
  rose: 'text-red-400',
  amber: 'text-amber-400/80',
  blue: 'text-zinc-400',
  slate: 'text-zinc-500',
  violet: 'text-zinc-300',
  orange: 'text-orange-400',
};

export function Badge({
  tone = 'slate',
  children,
  mono = false,
  className,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border border-void-600 bg-void-800 px-1.5 py-px text-[10px] leading-4',
        TONE[tone],
        mono && 'font-mono',
        className,
      )}
    >
      {children}
    </span>
  );
}

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

export function severityTone(sev: string): BadgeTone {
  switch (sev) {
    case 'critical': return 'red';
    case 'high': return 'orange';
    case 'medium': return 'amber';
    case 'low': return 'blue';
    default: return 'slate';
  }
}

export function riskTone(risk: string): BadgeTone {
  switch (risk) {
    case 'exploit': return 'red';
    case 'credential': return 'red';
    case 'intrusive': return 'amber';
    default: return 'slate';
  }
}

export function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'running':
    case 'active':
      return 'orange';
    case 'connected':
    case 'success':
    case 'verified':
      return 'slate';
    case 'waiting_approval':
    case 'blocked':
    case 'paused':
      return 'slate';
    case 'error':
    case 'failed':
    case 'disconnected':
      return 'red';
    case 'idle':
    case 'pending':
    default:
      return 'slate';
  }
}
