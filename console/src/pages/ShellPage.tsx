import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { TerminalSquare, RefreshCw, Loader2, Radio } from 'lucide-react';
import { cn } from '../utils/cn';

interface ShellHandle {
  id: string; name: string; target: string; transport: string;
  status: string; user: string | null; os: string | null;
  cmdCount: number; createdAt: string; expiresAt: string;
  /** F61: 后端一直返回但 UI 从未显示——运维/编排都依赖 */
  lastActiveAt?: string | null;
  /** R19-F1: 后端契约 {n,command,code,ms,at}(shells.mjs 注释明文)——
   * 此前声明 string[] 并 join, 渲染 '[object Object]' 乱码。 */
  tasks?: { n: number; command: string; code: number | string; ms: number; at: string | null }[];
  note?: string | null;
}
interface ExecResult { ok: boolean; stdout?: string; stderr?: string; code?: number; error?: string; ms?: number }

/** Shell 控制台 — C2 植入通道的运维终端(SSH 式) */
export function ShellPage() {
  const [shells, setShells] = useState<ShellHandle[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [cmd, setCmd] = useState('');
  const [lines, setLines] = useState<{ dir: 'in' | 'out' | 'err' | 'sys'; text: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);  // FEBUGS-P2-2: await 后读现值(闭包 active 是旧值)
  activeRef.current = active;

  const reload = () => api<{ shells: ShellHandle[] }>('/shells')
    .then(d => setShells(d.shells ?? []))
    .catch(e => setErr(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    void reload();
    // R32D50-F7: 10s 轮询——shell 由 agent 侧异步注册/过期, 此前只在
    // 手动刷新/操作后重拉, 列表常年陈旧。
    const iv = setInterval(() => void reload(), 10_000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => { if (!active && shells.length) setActive(shells[0].id); }, [shells, active]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 1e9 }); }, [lines]);

  const cur = shells.find(s => s.id === active) ?? null;

  async function closeShell(s: ShellHandle) {
    if (!window.confirm(`关闭通道 ${s.name ?? s.id}?(${s.target} · 一次性纪律, 关闭后不可再执行)`)) return;
    try {
      await api(`/shells/${s.id}/close`, { method: 'POST' });
      if (active === s.id) { setActive(null); setLines([]); }
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  const [hist, setHist] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);  // R32D84-N3: ↑/↓ 命令历史
  async function run() {
    if (!cur || !cmd.trim() || busy) return;
    const shellId = cur.id;  // FEBUGS-P2-2: 捕获执行时 shell——await 后
    // 切换 shell 时在途输出不得串台到新 shell(此前无条件 setLines)。
    const c = cmd; setCmd(''); setBusy(true);
    setHist(h => (h[h.length - 1] === c ? h : [...h, c]));  // 去连续重复
    setHistIdx(-1);
    setLines(l => [...l, { dir: 'in', text: `${cur.user || '?'}@${cur.target}:~$ ${c}` }]);
    try {
      const r = await api<ExecResult>(`/shells/${shellId}/exec`, { method: 'POST', json: { command: c, timeoutMs: 60000 } });
      if (activeRef.current !== shellId) return void reload();  // 已切换: 输出弃置
      if (r.error) setLines(l => [...l, { dir: 'err', text: r.error! }]);
      else {
        if (r.stdout) setLines(l => [...l, { dir: 'out', text: String(r.stdout) }]);
        if (r.stderr) setLines(l => [...l, { dir: 'err', text: String(r.stderr) }]);
        setLines(l => [...l, { dir: 'sys', text: `[exit ${r.code ?? '?'} · ${r.ms ?? '?'}ms]` }]);
      }
    } catch (e) {
      if (activeRef.current === shellId) setLines(l => [...l, { dir: 'err', text: e instanceof Error ? e.message : String(e) }]);
    }
    if (activeRef.current === shellId) setBusy(false);
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
            无 shell。C2 agent 交付验收通过后注册;或经 POST /api/shells 注册(缺省 web 传输; local 用于 benchmark)。
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
            <div className="mt-0.5 font-mono text-[10px] text-zinc-500">{s.target} · {s.cmdCount} cmd{s.lastActiveAt ? ` · 活跃 ${s.lastActiveAt.slice(5, 16)}` : ''}</div>
            {(s.tasks?.length ?? 0) > 0 && (
              <div className="mt-0.5 truncate font-mono text-[9.5px] text-sky-400/70" title={s.tasks!.map(t => t.command).join(', ')}>任务: {s.tasks!.map(t => t.command).join(', ')}</div>
            )}
            {/* CS62-#4: 外层是 button, HTML 禁 interactive 嵌套——用
                span role=button(同 VulnPanel 先例)替代内层 button。 */}
            {s.status === 'active' && (
              <span
                role="button"
                tabIndex={0}
                onClick={e => { e.stopPropagation(); closeShell(s); }}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); closeShell(s); } }}
                className="mt-1 inline-block cursor-pointer rounded-sm border border-red-900/60 px-1.5 py-0.5 text-[9.5px] text-red-400/80 hover:border-red-700 hover:text-red-300"
                title="关闭通道(一次性纪律下的即时终止)"
              >关闭</span>
            )}
          </button>
        ))}
      </div>

      {cur && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-void-700 bg-void-950">
          <div className="flex items-center gap-2 border-b border-void-800 bg-void-900/60 px-3 py-1.5 font-mono text-[10.5px] text-zinc-400">
            <span className="text-emerald-400">●</span>
            <span>{cur.user || '?'}@{cur.target}</span>
            <span className="truncate text-zinc-600">{(cur.os || '').slice(0, 60)}</span>
            <span className="ml-auto text-zinc-600">{cur.transport} · 到期 {cur.expiresAt.slice(5, 16)}{cur.lastActiveAt ? ` · 活跃 ${cur.lastActiveAt.slice(11, 16)}` : ''}</span>
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
            <input value={cmd} onChange={e => { setCmd(e.target.value); setHistIdx(-1); }}
              onKeyDown={e => {
                if (e.key === 'ArrowUp' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  const n = histIdx < 0 ? hist.length - 1 : Math.max(0, histIdx - 1);
                  if (hist.length) { setHistIdx(n); setCmd(hist[n]); }
                } else if (e.key === 'ArrowDown' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  const n = histIdx + 1;
                  if (histIdx < 0) setCmd('');
                  else if (n >= hist.length) { setHistIdx(-1); setCmd(''); }
                  else { setHistIdx(n); setCmd(hist[n]); }
                } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) void run();  // R11-F5: IME 同款(R8-F1)
              }}
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
