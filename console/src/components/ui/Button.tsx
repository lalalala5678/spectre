import type { ButtonHTMLAttributes } from 'react';

import { cn } from '../../utils/cn';
/** §5.1 Button: 四变体 × 四尺寸, 统一 focus-visible ring(≥3:1), 图标钮 32px 命中区(D7)。
 * §7-6 修订: sm 由 h-7(28px) 升 h-8(32px)——规格 §5.1 与 §7-6(≥32px) 此前
 * 自相矛盾, 以验收硬指标 §7-6 为准统一。 */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg' | 'icon';

const BASE =
  'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white shadow-xs hover:bg-accent-hover active:bg-accent-hover',
  secondary: 'border border-line-strong bg-surface text-secondary shadow-xs hover:bg-surface-2 hover:text-primary',
  ghost: 'text-secondary hover:bg-surface-2 hover:text-primary',
  danger: 'border border-danger-line bg-danger-bg text-danger-text hover:brightness-95',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-2.5 text-xs', // §7-6: ≥32px 命中区
  md: 'h-8 px-3 text-sm',
  lg: 'h-9 px-4 text-sm',
  icon: 'h-8 w-8 p-0', // ≥32px 命中区
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button type={type} className={cn(BASE, VARIANTS[variant], SIZES[size], className)} {...props} />;
}
