import type { HTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

import { cn } from '../../utils/cn';

/** §5.4 表单控件: h-8 圆角 md, 交互边界 line-strong(≥3:1), focus 组合
 * border-ring + ring/25(D6); placeholder 一律 text-faint 且仅示例文本。 */
const FIELD =
  'w-full rounded-md border border-line-strong bg-surface px-2.5 text-sm text-primary shadow-xs transition-colors placeholder:text-faint hover:border-line-strong/70 focus:border-ring focus:ring-2 focus:ring-ring/25 focus-visible:outline-none disabled:opacity-50';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(FIELD, 'h-8', className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(FIELD, 'min-h-20 py-2 leading-relaxed', className)} {...props} />;
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(FIELD, 'h-8 cursor-pointer pr-8', className)} {...props}>
      {children}
    </select>
  );
}

/** §5.4 label 13px medium secondary / hint 12px tertiary */
export function Label({ className, ...props }: HTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-[13px] font-medium text-secondary', className)} {...props} />;
}

export function Hint({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-xs text-tertiary', className)} {...props} />;
}
