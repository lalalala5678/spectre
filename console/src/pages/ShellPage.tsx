import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { Loader2, Radio, RefreshCw, TerminalSquare } from 'lucide-react';
import { ConfirmButton } from '../components/ui/ConfirmButton';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { cn } from '../utils/cn';
import { usePageTitle } from '../utils/usePageTitle';

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
export function ShellPage({ wsId }: { wsId: string | null }) {
  usePageTitle('Shell 控制台'); // FEVERIFY-N3
  const [shells, setShells] = useState<ShellHandle[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [cmd, setCmd] = useState('');
  const [lines, setLines] = useState<{ dir: 'in' | 'out' | 'err' | 'sys'; text: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [readOpen, setReadOpen] = useState(false);
  const [readPath, setReadPath] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);  // FEBUGS-P2-2: await 后读现值(闭包 active 是旧值)
  activeRef.current = active;

  const reload = () => {
    if (!wsId) return Promise.resolve();  // r50b: 无项目不拉(空串曾拉全量)
    return api<{ shells: ShellHandle[] }>(`/shells?workSessionId=${encodeURIComponent(wsId)}`)
      .then(d => { setShells(d.shells ?? []); setErr(''); })  // P3-9: 成功即清除陈旧错误
      .catch(e => setErr(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    void reload();
    // R32D50-F7: 10s 轮询——shell 由 agent 侧异步注册/过期, 此前只在
    // 手动刷新/操作后重拉, 列表常年陈旧。r50b: deps [wsId]——App 层
    // wsId 异步就绪后旧闭包(首帧 null)曾持续拉全量。
    const iv = setInterval(() => void reload(), 10_000);
    return () => clearInterval(iv);
  }, [wsId]);  // eslint-disable-line react-hooks/exhaustive-deps
  // r50b: 过滤集变化后 active 失效回落(跳回列表根因之一)
  useEffect(() => {
    if (active && shells.length && !shells.some(s => s.id === active)) {
      setActive(shells[0].id); setLines([]);
    }
  }, [shells, active]);
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
  const [histIdx, setHistIdx] = useState(-1);
  const draftRef = useRef('');  // FEVERIFY-P3-9: ↑前进时丢草稿  // R32D84-N3: ↑/↓ 命令历史
  async function doRead() {
    const f = readPath.trim();
    if (!f || !cur) return;
    try {
      const r = await api<{ stdout?: string; error?: string }>(`/shells/${cur.id}/read-file`, { method: 'POST', json: { path: f } });
      setLines(l => [...l, { dir: r.error ? 'err' : 'out', text: `── read ${f} ──\n${r.error ?? r.stdout ?? '(空)'}` }]);
    } catch (e) {
      setLines(l => [...l, { dir: 'err', text: `read 失败: ${e instanceof Error ? e.message : String(e)}` }]);
    }
    setReadOpen(false);
  }
  async function run() {
    if (!cur || !cmd.trim() || busy) return;
    const shellId = cur.id;  // FEBUGS-P2-2: 捕获执行时 shell——await 后
    // 切换 shell 时在途输出不得串台到新 shell(此前无条件 setLines)。
    const c = cmd; setCmd(''); setErr(''); setBusy(true);  // FEVERIFY-P3-9
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
          <h1 className="flex items-center gap-2 text-lg font-semibold text-primary">
            <TerminalSquare className="h-5 w-5 text-accent-text" />Shell 控制台
          </h1>
          <p className="mt-1 text-[13px] text-tertiary">
            C2 植入通道的运维终端——授权窗口内经服务端授权门执行;亦可把 shellId 交给 权限维持/后渗透 agent 代操作。
          </p>
        </div>
        <Button onClick={() => void reload()} variant="ghost" size="icon" aria-label="刷新 shell 列表" title="刷新" className="mb-1">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {err && <div className="mb-3 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-[13px] text-danger-text">{err}</div>}

      {/* r50c: 限高滚动——多 shell 时 exec 面板不被挤出视口 */}
      {/* r50e: 行式列表(每个关闭按钮可见) */}
      <div className="mb-3 max-h-[42vh] divide-y divide-line overflow-y-auto rounded-lg border border-line">
        {shells.length === 0 && (
          <div className="p-4">
            <EmptyState icon={TerminalSquare} title="无 shell"
              hint="C2 agent 交付验收通过后注册;或经 POST /api/shells 注册(缺省 web 传输; local 用于 benchmark)。" />
          </div>
        )}
        {shells.map(s => (
          <div key={s.id}
            className={cn('flex items-center gap-2 px-3 py-1.5',
              s.id === active ? 'bg-accent-subtle' : 'hover:bg-surface-2')}>
            <Radio className={cn('h-3 w-3 shrink-0', s.status === 'active' ? 'text-success-text' : 'text-faint')} />
            <button onClick={() => { setActive(s.id); setLines([]); }}
              className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <span className="shrink-0 text-sm font-medium text-primary">{s.name || s.id}</span>
              <span className="truncate font-mono text-xs text-tertiary">{s.target} · {s.cmdCount} cmd{s.lastActiveAt ? ` · ${s.lastActiveAt.slice(5, 16)}` : ''}</span>
            </button>
            {s.status === 'active' && (
              <ConfirmButton label="关闭" confirmLabel="确认关闭" variant="ghost" size="sm"
                className="shrink-0 text-xs text-danger-text" onConfirm={() => void closeShell(s)} />
            )}
          </div>
        ))}
      </div>

      {cur && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-bg shadow-xs">
          <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-xs text-secondary">
            <span className="text-success-text">●</span>
            <span className="tabular-nums">{cur.user || '?'}@{cur.target}</span>
            <span className="truncate text-tertiary">{(cur.os || '').slice(0, 60)}</span>
            <span className="ml-auto text-tertiary tabular-nums">{cur.transport} · 到期 {cur.expiresAt.slice(5, 16)}{cur.lastActiveAt ? ` · 活跃 ${cur.lastActiveAt.slice(11, 16)}` : ''}</span>
            <Button size="sm" variant="ghost" className="ml-2"
              onClick={() => void api<{ shell: Record<string, unknown> }>(`/shells/${cur.id}`)
                .then(r => { setLines(l => [...l, { dir: 'sys', text: '── status ──\n' + JSON.stringify(r.shell, null, 1) }]); })}>
              状态</Button>
            <Button size="sm" variant="ghost" className="ml-1" onClick={() => setReadOpen(v => !v)}>读文件</Button>
          </div>
          <div ref={scrollRef} tabIndex={0} aria-label="终端输出" className="min-h-0 flex-1 overflow-y-auto p-3 font-mono text-[13px] leading-6">
            {lines.map((l, i) => (
              <pre key={i} className={cn('whitespace-pre-wrap break-all',
                l.dir === 'in' ? 'text-accent-text' : l.dir === 'err' ? 'text-danger-text' : l.dir === 'sys' ? 'text-tertiary' : 'text-primary')}>{l.text}</pre>
            ))}
            {lines.length === 0 && <div className="text-tertiary">— 在下方输入命令(经服务端授权门) —</div>}
          </div>
          {readOpen && (
            <div className="flex items-center gap-2 border-t border-line bg-surface-2/40 px-3 py-1.5">
              <span className="shrink-0 text-xs text-tertiary">读取远端文件</span>
              <input value={readPath} onChange={e => setReadPath(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && readPath.trim()) void doRead(); }}
                placeholder="/绝对/路径"
                className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 font-mono text-xs" />
              <Button size="sm" variant="primary" disabled={!readPath.trim()} onClick={() => void doRead()}>读取</Button>
            </div>
          )}
          <div className="flex h-12 items-center gap-2 border-t border-line px-3">
            <span className="font-mono text-[13px] text-accent-text">$</span>
            <input value={cmd} onChange={e => { setCmd(e.target.value); setHistIdx(-1); }}
              onKeyDown={e => {
                if (e.key === 'ArrowUp' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (histIdx < 0) draftRef.current = cmd;  // FEVERIFY2-N2-1(真修): 进历史前存草稿
                  const n = histIdx < 0 ? hist.length - 1 : Math.max(0, histIdx - 1);
                  if (hist.length) { setHistIdx(n); setCmd(hist[n]); }
                } else if (e.key === 'ArrowDown' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  const n = histIdx + 1;
                  if (histIdx < 0) { setCmd(draftRef.current); draftRef.current = ''; }
                  else if (n >= hist.length) { setHistIdx(-1); setCmd(''); }
                  else { setHistIdx(n); setCmd(hist[n]); }
                } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) void run();  // R11-F5: IME 同款(R8-F1)
              }}
              placeholder="command…"
              className="h-8 flex-1 rounded-md bg-transparent px-1 font-mono text-[13px] text-primary outline-none placeholder:text-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />
            <Button onClick={() => void run()} disabled={busy || !cmd.trim()} variant="primary" size="sm">
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : '执行'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
