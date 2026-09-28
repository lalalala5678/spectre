import { useEffect, useState } from 'react';
import { Activity, Bell, LogOut, Search } from 'lucide-react';

import { api } from '../api/client';

/** F60: /api/health 前端零消费——模型名/会话总量/总线事件总量后端有、
 * 用户无从得知。状态栏 30s 轮询展示(ok 掉线变红)。 */
interface HealthInfo { ok: boolean; model: string; sessions: number; bus: number; }

/** F25: 原 fmtTime 为 mock 冻结时钟(2026-09-06 硬编码)——改实时时钟 */
export function Topbar() {
  const [now, setNow] = useState(() => new Date());
  const [health, setHealth] = useState<HealthInfo | null>(null);
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
  const fmt = (d: Date) => d.toLocaleString('sv-SE', { hour12: false }).replace('T', ' ');
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-void-700 bg-void-900 px-3.5">
      {/* 全局搜索 */}
      <div className="relative w-80">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
        <input
          placeholder="搜索会话 / 资产 / 发现 / CVE…"
          className="w-full rounded-sm border border-void-600 bg-void-800 py-1.5 pl-8 pr-3 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-void-500"
        />
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
