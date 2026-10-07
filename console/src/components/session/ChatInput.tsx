import { useEffect, useRef, useState } from 'react';
import { FileUp, SendHorizonal } from 'lucide-react';
import { Button } from '../ui/Button';
import { Kbd } from '../ui/Kbd';

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
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 用户令: Ctrl+Z/Ctrl+Y(及 Ctrl+Shift+Z)撤销重做——受控组件+程序性
  // setValue(上传注入/发送清空)会断浏览器原生 undo 栈, 自建快照栈。
  const hist = useRef<{ stack: string[]; idx: number }>({ stack: [''], idx: 0 });
  const pushHist = (v: string) => {
    const h = hist.current;
    if (h.stack[h.idx] === v) return;
    h.stack = h.stack.slice(0, h.idx + 1);
    h.stack.push(v);
    if (h.stack.length > 100) h.stack.shift();
    h.idx = h.stack.length - 1;
  };
  const setVal = (v: string) => { setValue(v); pushHist(v); };

  /** Attachment → /opt/uploads (sandbox-visible to every agent). */
  const upload = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/spectre/api/sandbox/uploads', {
        method: 'POST', body: form, credentials: 'include' });
      if (res.redirected && res.url.includes('/login')) { window.location.assign('/spectre/login'); return; }  // R8-F5: 判定写反(对照 client.ts)
      // R3-5: 非 2xx(400/413…)此前落入成功分支, 拼出'[已上传 undefined]'
      // 伪成功路径——显式抛错走 catch 的'上传失败'。
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as { sandboxPath: string };
      setVal(value + (value ? '\n' : '') + `[已上传 ${data.sandboxPath}] `);
      inputRef.current?.focus();
    } catch (e) {
      setVal(value + `[上传失败:${String(e)}] `);
    } finally { setUploading(false); }
  };

  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy]);

  const submit = (steer: boolean) => {
    const text = value.trim();
    if (!text) return;
    onSend(text, busy || steer ? 'steer' : 'prompt');
    setVal('');
    // FEVERIFY-P3-3: 高度经 onChange 自管, 清值不经 onChange→残留, 显式复位。
    requestAnimationFrame(() => {
      const ta = document.activeElement as HTMLTextAreaElement | null;
      if (ta && ta.tagName === 'TEXTAREA') {
        ta.style.height = 'auto';
      }
    });
  };

  return (
    <div className="@container rounded-lg border border-line bg-bg py-1.5 focus-within:border-line-strong">
      <div className="flex items-center gap-2 px-3">
        <span className="shrink-0 text-sm text-accent-text">
          {busy ? '⇢' : '›'}
        </span>
        <input
          ref={fileRef} type="file" className="hidden"
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = '';
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          title="上传文件到沙箱 /opt/uploads(所有智能体可读)"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-faint hover:text-secondary disabled:opacity-40"
          aria-label="上传文件"
        >
          <FileUp className="h-3.5 w-3.5" />
        </button>
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setVal(e.target.value);
            const el = e.target as HTMLTextAreaElement;
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 160) + 'px';
          }}
          placeholder={busy ? `${placeholder}(智能体忙碌,将以 steering 插入)` : placeholder}
          className="min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm leading-5 text-primary placeholder:text-faint outline-none"
          rows={1}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;  // R8-F1: IME 组合期 Enter 是确认候选, 不是提交
            const undoKey = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z';
            const redoKey = (e.ctrlKey || e.metaKey) && !e.altKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'));
            if (undoKey && !e.shiftKey) {
              e.preventDefault();
              const h = hist.current;
              if (h.idx > 0) { h.idx -= 1; setValue(h.stack[h.idx]); }
              return;
            }
            if (redoKey) {
              e.preventDefault();
              const h = hist.current;
              if (h.idx < h.stack.length - 1) { h.idx += 1; setValue(h.stack[h.idx]); }
              return;
            }
            if (e.key === 'Enter' && e.shiftKey) {
              return; // plain newline — textarea default, never submits
            }
            if (e.key === 'Enter' && !e.altKey) {
              e.preventDefault();
              submit(false);
              (e.target as HTMLTextAreaElement).style.height = 'auto';
            } else if (e.key === 'Enter' && e.altKey) {
              submit(true); // steering interjection while busy
            }
          }}
        />
        {/* FEVERIFY6-P2: 窄容器收纳——行内放不下时提示退场(容器查询), 不再挤死 textarea */}
        <span className="flex shrink-0 items-center gap-1 text-[13px] text-tertiary @[380px]:flex hidden">
          {busy
            ? <><Kbd>Alt+Enter</Kbd> 插话</>
            : <><Kbd>Enter</Kbd> 发送 · <Kbd>Shift+Enter</Kbd> 换行</>}
        </span>
        <Button
          variant="primary"
          size="icon"
          onClick={() => submit(false)}
          disabled={!value.trim()}
          className="shrink-0"
        >
          <SendHorizonal className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
