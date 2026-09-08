import { cn } from '../../utils/cn';

export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cn(
        'relative h-4 w-7.5 shrink-0 rounded-full transition-colors',
        checked ? 'bg-orange-600' : 'bg-void-500',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-3 w-3 rounded-full bg-zinc-200 transition-all',
          checked ? 'left-4' : 'left-0.5',
        )}
      />
    </button>
  );
}
