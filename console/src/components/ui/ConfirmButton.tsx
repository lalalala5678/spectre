/**
 * r50e: 原生弹窗(alert/confirm/prompt)全站禁用(用户令)。两击式危险
 * 确认: 第一次点变成「确认?」, 3s 内再点才执行; 页面内完成, 零弹窗。
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';

export function ConfirmButton({ label, confirmLabel = '确认?', onConfirm, ...rest }: {
  label: React.ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  variant?: 'ghost' | 'danger' | 'primary' | 'ghostChrome';
  size?: 'sm' | 'icon';
  className?: string;
  title?: string;
}) {
  const [armed, setArmed] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  return (
    <Button
      {...rest}
      variant={armed ? 'danger' : (rest.variant ?? 'ghost')}
      onClick={() => {
        if (armed) { setArmed(false); if (t.current) clearTimeout(t.current); onConfirm(); return; }
        setArmed(true);
        t.current = setTimeout(() => setArmed(false), 3000);
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}
