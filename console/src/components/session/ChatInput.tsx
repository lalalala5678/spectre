import { useEffect, useRef, useState } from 'react';
import { SendHorizonal } from 'lucide-react';

/** CLI-style chat input used by live sessions. */
export function ChatInput({
  placeholder,
  busy = false,
  onSend,
}: {
  placeholder: string;
  busy?: boolean;
  onSend: (text: string, mode: 'prompt' | 'steer') => void;
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy]);

  const submit = (steer: boolean) => {
    const text = value.trim();
    if (!text) return;
    onSend(text, busy || steer ? 'steer' : 'prompt');
    setValue('');
  };

  return (
    <div className="rounded-sm border border-void-600 bg-void-950 focus-within:border-void-500">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="shrink-0 font-mono text-[13px] text-orange-400">
          {busy ? '⇢' : '›'}
        </span>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={busy ? `${placeholder}(智能体忙碌,将以 steering 插入)` : placeholder}
          className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-zinc-200 placeholder:text-zinc-700 outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.altKey) submit(false);
            else if (e.key === 'Enter' && e.altKey) submit(true);
          }}
        />
        <span className="shrink-0 font-mono text-[9.5px] text-zinc-700">
          {busy ? 'ENTER=插话' : 'ENTER=发送'}
        </span>
        <button
          onClick={() => submit(false)}
          disabled={!value.trim()}
          className="shrink-0 rounded-sm p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
        >
          <SendHorizonal className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
