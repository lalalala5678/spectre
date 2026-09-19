import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { TerminalSquare, RefreshCw, Loader2, Radio } from 'lucide-react';
import { cn } from '../utils/cn';

interface ShellHandle {
  id: string; name: string; target: string; transport: string;
  status: string; user: string | null; os: string | null;
  cmdCount: number; createdAt: string; expiresAt: string;
}
interface ExecResult { ok: boolean; stdout?: string; stderr?: string; code?: number; error?: string; ms?: number }

/** Shell 控制台 — C2 植入通道的运维终端(SSH 式) */
export default function ShellPage() {
  const [shells, setShells] = useState<ShellHandle[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [cmd, setCmd] = useState('');
  const [lines, setLines] = useState<{ dir: 'in' | 'out' | 'err' | 'sys'; text: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const reload = () => api<{ shells: ShellHandle[] }>('/shells')
    .then(d => setShells(d.shells ?? []))
    .catch(e => setErr(e instanceof Error ? e.message : String(e)));
  useEffect(() => { void reload(); }, []);
  useEffect(() => { if (!active && shells.length) setActive(shells[0].id); }, [shells, active]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 1e9 }); }, [lines]);

  const cur = shells.find(s => s.id === active) ?? null;

  async function run() {
    if (!cur || !cmd.trim() || busy) return;
    const c = cmd; setCmd(''); setBusy(true);
    setLines(l => [...l, { dir: 'in', text: `${cur.user || '?'}@${cur.target}:~$ ${c}` }]);
    try {
      const r = await api<ExecResult>(`/shells/${cur.id}/exec`, { method: 'POST', json: { command: c, timeoutMs: 60000 } });
      if (r.error) setLines(l => [...l, { dir: 'err', text: r.error! }]);
      else {
        if (r.stdout) setLines(l => [...l, { dir: 'out', text: String(r.stdout) }]);
        if (r.stderr) setLines(l => [...l, { dir: 'err', text: r.stderr }]);
        setLines(l => [...l, { dir: 'sys', text: `[exit ${r.code ?? '?'} · ${r.ms ?? '?'}ms]` }]);
      }
    } catch (e) {
      setLines(l => [...l, { dir: 'err', text: e instanceof Error ? e.message : String(e) }]);
    }
    setBusy(false);
    void reload();
  }

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col px-6 py-6">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-[16px] font-medium text-zinc-100">
            <TerminalSquare className="h-4 w-4 text-orange-400" />Shell 控制台
          </h1>
          <p className="mt-1 text-[11.5px] text-zinc-500">
            C2 植入通道的运维终端——授权窗口内经服务端授权门执行;亦可把 shellId 交给 权限维持/后渗透 agent 代操作。
          </p>
        </div>
        <button onClick={() => void reload()} className="mb-1 text-zinc-600 transition-colors hover:text-zinc-300">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {err && <div className="mb-3 rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-[11.5px] text-red-300">{err}</div>}

      <div className="mb-3 grid grid-cols-2 gap-2 overflow-x-auto md:grid-cols-4">
        {shells.length === 0 && (
          <div className="col-span-full rounded border border-void-700 bg-void-900/30 px-3 py-4 text-center text-[11.5px] text-zinc-500">
            无 shell。C2 agent 交付验收通过后注册;或经 POST /api/shells 注册(local 传输用于 benchmark)。
          </div>
        )}
        {shells.map(s => (
          <button key={s.id} onClick={() => { setActive(s.id); setLines([]); }}
            className={cn('rounded border px-3 py-2 text-left transition-colors',
              s.id === active ? 'border-orange-700 bg-orange-950/20' : 'border-void-700 bg-void-900/30 hover:border-void-500')}>
            <div className="flex items-center gap-1.5">
              <Radio className={cn('h-3 w-3', s.status === 'active' ? 'text-emerald-400' : 'text-zinc-600')} />
              <span className="font-mono text-[12px] text-zinc-200">{s.name || s.id}</span>
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-zinc-500">{s.target} · {s.cmdCount} cmd</div>
          </button>
        ))}
      </div>

      {cur && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-void-700 bg-void-950">
          <div className="flex items-center gap-2 border-b border-void-800 bg-void-900/60 px-3 py-1.5 font-mono text-[10.5px] text-zinc-400">
            <span className="text-emerald-400">●</span>
            <span>{cur.user || '?'}@{cur.target}</span>
            <span className="truncate text-zinc-600">{(cur.os || '').slice(0, 60)}</span>
            <span className="ml-auto text-zinc-600">{cur.transport} · 到期 {cur.expiresAt.slice(5, 16)}</span>
          </div>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-3 font-mono text-[12px] leading-relaxed">
            {lines.map((l, i) => (
              <pre key={i} className={cn('whitespace-pre-wrap break-all',
                l.dir === 'in' ? 'text-orange-300' : l.dir === 'err' ? 'text-red-400' : l.dir === 'sys' ? 'text-zinc-600' : 'text-zinc-300')}>{l.text}</pre>
            ))}
            {lines.length === 0 && <div className="text-zinc-600">— 在下方输入命令(经服务端授权门) —</div>}
          </div>
          <div className="flex items-center gap-2 border-t border-void-800 px-3 py-2">
            <span className="font-mono text-[12px] text-orange-300">$</span>
            <input value={cmd} onChange={e => setCmd(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void run(); }}
              placeholder="command…"
              className="flex-1 bg-transparent font-mono text-[12.5px] text-zinc-200 outline-none placeholder:text-zinc-700" />
            <button onClick={() => void run()} disabled={busy || !cmd.trim()}
              className="flex items-center gap-1.5 rounded border border-orange-700 bg-orange-950/40 px-3 py-1 font-mono text-[11px] text-orange-300 disabled:opacity-40">
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : '执行'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
