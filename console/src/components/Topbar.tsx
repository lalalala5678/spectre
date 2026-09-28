import { useEffect, useRef, useState } from 'react';
import { Activity, Bell, LogOut, Search } from 'lucide-react';

import { api } from '../api/client';

/** F60: /api/health 前端零消费——模型名/会话总量/总线事件总量后端有、
 * 用户无从得知。状态栏 30s 轮询展示(ok 掉线变红)。 */
interface HealthInfo { ok: boolean; model: string; sessions: number; bus: number; }

interface TreeSess { id: string; agentKey: string; title: string | null; busy?: boolean }
interface BusEvt { seq: number; type: string | null; title: string | null; summary: string | null }

/** F69: 顶栏搜索此前是空壳(placeholder 承诺"会话/资产/发现/CVE"但无任何
 * 逻辑)。实现: ≥2 字符防抖搜索会话(/sessions/tree 轻投影)+总线条目
 * (intel/vulnerability/task-report 的 title/summary, CVE 正则加权)。 */
const SEARCHABLE = new Set(['intel', 'intel-note', 'vulnerability', 'task-report']);

export function Topbar() {
  const [now, setNow] = useState(() => new Date());
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [sessHits, setSessHits] = useState<TreeSess[]>([]);
  const [busHits, setBusHits] = useState<BusEvt[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    let stopped = false;
    const poll = () => api<HealthInfo>('/health')
      .then(h => { if (!stopped) setHealth(h); })
      .catch(() => { if (!stopped) setHealth(null); });
    poll();
    const t = setInterval(poll, 30_000);
    return () => { stopped = true; clearInterval(t); };
  }, []);

  // F69: 防抖搜索(会话树 + 总线条目; 结果缓存 30s)
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) { setSessHits([]); setBusHits([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const lower = query.toLowerCase();
        const cve = /cve-\d{4}-\d+/i.test(query);
        const [tree, bus] = await Promise.all([
          api<TreeSess[]>('/sessions/tree'),
          api<BusEvt[]>('/bus'),
        ]);
        if (cancelled) return;
        setSessHits(tree.filter(s =>
          (s.title ?? '').toLowerCase().includes(lower) || s.id.includes(lower),
        ).slice(0, 5));
        setBusHits(bus.filter(e =>
          SEARCHABLE.has(String(e.type))
          && ((e.title ?? '').toLowerCase().includes(lower)
            || (e.summary ?? '').toLowerCase().includes(lower)
            || (cve && /CVE-\d{4}-\d+/i.test(`${e.title ?? ''} ${e.summary ?? ''}`))),
        ).slice(-6).reverse());
        setOpen(true);
      } catch { /* 下次击键重试 */ }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const go = (hash: string) => {
    setOpen(false);
    window.location.hash = hash;
  };

  const fmt = (d: Date) => d.toLocaleString('sv-SE', { hour12: false }).replace('T', ' ');
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-void-700 bg-void-900 px-3.5">
      {/* 全局搜索 (F69: 实装) */}
      <div ref={boxRef} className="relative w-80">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          onFocus={() => { if (q.trim().length >= 2) setOpen(true); }}
          onKeyDown={e => { if (e.key === 'Escape') { setOpen(false); setQ(''); } }}
          placeholder="搜索会话 / 资产 / 发现 / CVE…"
          className="w-full rounded-sm border border-void-600 bg-void-800 py-1.5 pl-8 pr-3 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-void-500"
        />
        {open && (sessHits.length > 0 || busHits.length > 0) && (
          <div className="absolute left-0 top-full z-30 mt-1 w-[26rem] rounded-sm border border-void-600 bg-void-900 p-1 shadow-lg">
            {sessHits.length > 0 && (
              <div className="mb-1 px-2 py-0.5 text-[9px] uppercase tracking-widest text-zinc-600">会话</div>
            )}
            {sessHits.map(s => (
              <button key={s.id} onClick={() => go(s.agentKey === 'autopwn' ? 'autopwn' : s.agentKey)}
                className="block w-full truncate rounded-sm px-2 py-1 text-left text-[11.5px] text-zinc-300 hover:bg-void-800">
                <span className="font-mono text-[9.5px] text-zinc-600">{s.agentKey}</span>
                {' '}{s.title ?? s.id}
              </button>
            ))}
            {busHits.length > 0 && (
              <div className="mt-1 mb-1 px-2 py-0.5 text-[9px] uppercase tracking-widest text-zinc-600">总线条目</div>
            )}
            {busHits.map(e => (
              <button key={e.seq} onClick={() => go(e.type === 'task-report' ? 'reports' : 'audit')}
                className="block w-full truncate rounded-sm px-2 py-1 text-left text-[11.5px] text-zinc-300 hover:bg-void-800">
                <span className="font-mono text-[9.5px] text-zinc-600">#{e.seq}</span>
                {' '}{e.title ?? e.summary ?? ''}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="font-mono text-[11px] text-zinc-600">{fmt(now)} 本地</div>

      {/* F60: 运行时状态(模型·会话·事件) */}
      <div
        title={health
          ? `模型 ${health.model} · 会话 ${health.sessions} · 总线事件 ${health.bus}`
          : 'runtime 不可达'}
        className="flex items-center gap-1.5 font-mono text-[10.5px] text-zinc-500"
      >
        <Activity className={health ? 'h-3 w-3 text-emerald-500' : 'h-3 w-3 text-red-500'} />
        {health
          ? <span>{health.model} · {health.sessions} 会话 · {health.bus} 事件</span>
          : <span className="text-red-400">runtime 不可达</span>}
      </div>

      <div className="flex-1" />

      <button
        onClick={() => { window.location.href = '/spectre/logout'; }}
        title="登出"
        className="rounded-sm p-1.5 text-zinc-500 hover:bg-void-800 hover:text-zinc-300"
      >
        <LogOut className="h-3.5 w-3.5" />
      </button>

      <button className="relative rounded-sm p-1.5 text-zinc-500 hover:bg-void-800 hover:text-zinc-300" title="通知">
        <Bell className="h-4 w-4" />
        <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-orange-500" />
      </button>
    </header>
  );
}
