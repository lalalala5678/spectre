/**
 * OverviewPage — 项目总览仪表盘(全平台 hub)。
 * 信息流: 状态扫(战役卡片) → 战果理解(环形图+最近发现) → 行动(深链)。
 * 数据面零后端新增: /api/sessions/tree + /api/bus(SSE) + /api/prefs。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Gauge, Plus } from 'lucide-react';
import { api, foldEntries, subscribeBus, type ApiBusEvent, type FoldedEntry } from '../api/client';
import { Dot } from '../components/ui/Badge';
import { SeverityBadge } from '../components/session/VulnPanel';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import {
  ensureWorkSession, listWorkSessions, switchWorkSession, newWorkSession,
  type WorkSession,
} from '../api/worksession';
import { setPendingOpen } from '../api/openSessionChannel';
import { cn } from '../utils/cn';
import { usePageTitle } from '../utils/usePageTitle';

/* ── Severity → CSS var (三主题自适应) ── */
const SEV_COLOR: Record<string, string> = {
  critical: 'var(--danger-text)',
  high: 'var(--warning-text)',
  medium: 'var(--info-text)',
  low: 'var(--text-faint)',
  info: 'var(--text-faint)',
};
const SEV_LABEL: Record<string, string> = {
  critical: '严重', high: '高危', medium: '中危', low: '低危', info: '信息',
};
const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

/* ── 活动流 type 白名单(含 legacy intel + 现行 intel-note) ── */
const ACTIVITY_TYPES = new Set(['vulnerability', 'intel', 'intel-note', 'scope', 'task-report']);
const ACTIVITY_BAR: Record<string, string> = {
  vulnerability: 'bg-danger-text/60',
  intel: 'bg-accent/60',
  'intel-note': 'bg-accent/60',
  scope: 'bg-success-text/60',
  'task-report': 'bg-secondary/60',
};
const NOISE_PREFIXES = ['[流量]', '[DM 存档', '[系统代拟'];

function isActivity(e: ApiBusEvent): boolean {
  if (!ACTIVITY_TYPES.has(e.type ?? '')) return false;
  const t = e.title ?? '';
  return !NOISE_PREFIXES.some(p => t.startsWith(p));
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return '刚刚';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}min 前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
  return `${Math.floor(ms / 86_400_000)}d 前`;
}
function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
}

/* ── SVG donut math ── */
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}
function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const [x1, y1] = polar(cx, cy, r, startDeg);
  const [x2, y2] = polar(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/* ── Count-up animation(增量感知: 起点=当前值, 不从 0 重数) ── */
function useCountUp(target: number, duration = 800): number {
  const [val, setVal] = useState(0);
  const fromRef = useRef(0);
  const rafRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min((t - t0) / duration, 1);
      const v = Math.round(from + (target - from) * (1 - Math.pow(1 - p, 3)));
      setVal(v);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);
  return val;
}

interface TreeSess {
  id: string; agentKey: string; title: string | null; busy?: boolean;
  engagementId?: string | null; workSessionId?: string | null;
  createdAt?: string; spawnName?: string | null;
}
interface EngagementGroup {
  engagementId: string;
  sessions: TreeSess[];
  busyCount: number;
  oldestTs: string | null;
}

export function OverviewPage() {
  usePageTitle('总览');
  const [ws, setWs] = useState<WorkSession | null>(null);
  const [projects, setProjects] = useState<WorkSession[]>([]);
  const [treeSess, setTreeSess] = useState<TreeSess[] | null>(null);
  const [busEvents, setBusEvents] = useState<FoldedEntry[]>([]);
  const [busLoaded, setBusLoaded] = useState(false);
  const [hoveredSev, setHoveredSev] = useState<string | null>(null);
  const [projOpen, setProjOpen] = useState(false);

  /* Boot: project + tree + bus(失败 1.2s 重试) */
  useEffect(() => {
    let stopped = false;
    const boot = async (retry = true) => {
      try {
        const [w, plist] = await Promise.all([ensureWorkSession(), listWorkSessions()]);
        if (stopped) return;
        setWs(w); setProjects(plist);
      } catch {
        if (retry && !stopped) setTimeout(() => void boot(false), 1200);
      }
    };
    void boot();
    return () => { stopped = true; };
  }, []);

  useEffect(() => {
    if (!ws) return;
    // R20-F2 同款: 切项目清空三态, 旧项目内容不得在新项目名下残闪
    setBusEvents([]); setBusLoaded(false); setTreeSess(null);
    let stopped = false;
    const fetchTree = async () => {
      try {
        const t = await api<TreeSess[]>(`/sessions/tree`);
        if (!stopped) setTreeSess(t);
      } catch { /* next poll heals */ }
    };
    void fetchTree();
    const treeTimer = setInterval(fetchTree, 4_000);
    const fetchBus = async (retry = true) => {
      try {
        const all = await api<ApiBusEvent[]>(`/bus?ws=${ws.id}`);
        if (stopped) return;
        setBusEvents(foldEntries(all));
        setBusLoaded(true);
      } catch {
        if (retry && !stopped) setTimeout(() => void fetchBus(false), 1200);
        else if (!stopped) setBusLoaded(true); // 降级: SSE 可自愈
      }
    };
    void fetchBus();
    // 性能权衡: SSE 增量走全量 refold(≤数千条 O(n)); useBusPanelEntries 对
    // 修订走重取原文走增量——本页事件量可受, 注释声明此取舍。
    const off = subscribeBus((_ch, raw) => {
      const e = raw as ApiBusEvent;
      if (e.workSessionId !== ws.id) return;
      setBusLoaded(true); // 首条 SSE 即解锁(首拉失败降级自愈)
      setBusEvents(prev => {
        const next = [...prev.filter(x => x.seq !== e.seq), { ...e, current: e, revisedCount: 0 } as FoldedEntry];
        return foldEntries(next);
      });
    });
    return () => { stopped = true; clearInterval(treeTimer); off(); };
  }, [ws?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- ws 对象变化即重跑(含项目切换)

  /* 项目切换(照 AgentWorkspacePage pickWorkSession 范式) */
  const pickProject = useCallback(async (id: string) => {
    const next = await switchWorkSession(id).catch(() => null);
    if (!next) return; // 项目已删/网络异常: 保持当前(防 setWs(null) 永骨架)
    setWs(next);
    setProjects(await listWorkSessions());
    setProjOpen(false);
  }, []);
  const createProject = useCallback(async () => {
    const name = `项目 ${new Date().toLocaleDateString('zh-CN')}`;
    const next = await newWorkSession(name).catch(() => null);
    if (!next) return;
    setWs(next);
    setProjects(await listWorkSessions());
    setProjOpen(false);
  }, []);

  /* Derived: severity counts (fold + legacy intel + ws filter + 含 info) */
  const sevCounts = useMemo(() => {
    const vulns = busEvents.filter(e => {
      const t = e.current?.type ?? e.type;
      return (t === 'vulnerability' || t === 'intel') && !(e.current?.void ?? e.void);
    });
    const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const v of vulns) {
      const s = (v.current?.severity ?? v.severity ?? 'info').toLowerCase();
      if (counts[s] !== undefined) counts[s]++;
    }
    return counts;
  }, [busEvents]);

  const totalVulns = useMemo(() =>
    SEV_ORDER.reduce((s, k) => s + sevCounts[k], 0), [sevCounts]);
  const displayCount = useCountUp(totalVulns);

  /* Derived: KPI */
  const kpi = useMemo(() => {
    const scope = busEvents.filter(e =>
      (e.current?.type ?? e.type) === 'scope' && !(e.current?.void ?? e.void));
    const intel = busEvents.filter(e =>
      (e.current?.type ?? e.type) === 'intel-note' && !(e.current?.void ?? e.void));
    const reports = busEvents.filter(e =>
      (e.current?.type ?? e.type) === 'task-report' && !(e.current?.void ?? e.void));
    const failed = reports.filter(e =>
      (e.current?.status ?? e.status) === 'failed').length;
    return { scope: scope.length, intel: intel.length, reports: reports.length, failed };
  }, [busEvents]);

  /* Derived: recent vulns (top 5) */
  const recentVulns = useMemo(() =>
    busEvents
      .filter(e => {
        const t = e.current?.type ?? e.type;
        return (t === 'vulnerability' || t === 'intel') && !(e.current?.void ?? e.void);
      })
      .sort((a, b) => b.seq - a.seq)
      .slice(0, 5), [busEvents]);

  /* Derived: activity feed (top 20) */
  const activities = useMemo(() =>
    busEvents
      .filter(e => isActivity(e.current ?? e) && !(e.current?.void ?? e.void))
      .sort((a, b) => b.seq - a.seq)
      .slice(0, 20), [busEvents]);

  /* Derived: engagements */
  const engagements = useMemo(() => {
    if (!treeSess) return null;
    const by = new Map<string, EngagementGroup>();
    for (const s of treeSess) {
      if (!s.engagementId) continue;
      if (ws && s.workSessionId !== ws.id) continue;
      const eid = s.engagementId.replace(/^autopwn-/, '');
      let g = by.get(eid);
      if (!g) { g = { engagementId: eid, sessions: [], busyCount: 0, oldestTs: null }; by.set(eid, g); }
      g.sessions.push(s);
      if (s.busy) g.busyCount++;
      if (s.createdAt && (!g.oldestTs || s.createdAt < g.oldestTs)) g.oldestTs = s.createdAt;
    }
    return [...by.values()].sort((a, b) =>
      (b.oldestTs ?? '').localeCompare(a.oldestTs ?? '')).slice(0, 5);
  }, [treeSess, ws?.id]);

  /* Latest bus event time */
  const lastEventTs = useMemo(() => {
    if (!busEvents.length) return null;
    const latest = busEvents.reduce((m, e) => e.seq > m.seq ? e : m, busEvents[0]);
    return latest.ts;
  }, [busEvents]);

  /* Donut segments */
  const segments = useMemo(() => {
    const total = totalVulns || 1;
    const active = SEV_ORDER.filter(k => sevCounts[k] > 0);
    const GAP = active.length > 1 ? 3 : 0;
    let angle = 0;
    return active.map(k => {
      const sweep = (sevCounts[k] / total) * (360 - GAP * active.length);
      const seg = { id: k, count: sevCounts[k], start: angle, end: angle + sweep, path: arcPath(100, 100, 70, angle, angle + sweep) };
      angle += sweep + GAP;
      return seg;
    });
  }, [sevCounts, totalVulns]);

  /* Donut center text */
  const centerCount = hoveredSev ? sevCounts[hoveredSev] : displayCount;
  const centerLabel = hoveredSev ? SEV_LABEL[hoveredSev] : '漏洞';

  const goAutopwn = useCallback((sessionId?: string) => {
    if (sessionId) setPendingOpen('autopwn', sessionId);
    window.location.hash = '#/autopwn';
  }, []);

  /* Loading */
  if (!ws || !treeSess || !busLoaded) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-6 pt-5">
        <Skeleton className="h-10 w-full rounded-lg" />
        <div className="flex gap-3">
          <Skeleton className="h-28 w-[220px] rounded-lg" />
          <Skeleton className="h-28 w-[220px] rounded-lg" />
        </div>
        <div className="flex gap-3">
          <Skeleton className="h-56 w-[40%] rounded-lg" />
          <Skeleton className="h-56 flex-1 rounded-lg" />
        </div>
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }

  /* Empty: new user / no meaningful data */
  const hasAnyData = totalVulns > 0 || kpi.scope > 0 || kpi.intel > 0
    || kpi.reports > 0 || (engagements?.length ?? 0) > 0 || activities.length > 0;
  if (!hasAnyData) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <EmptyState
          icon={Gauge}
          title="开始你的第一场渗透"
          hint="在 AutoPwn 工作台输入目标, 席位自动编排测绘→验证→落账"
          action={<Button variant="primary" onClick={() => goAutopwn()}>
            <Plus className="h-4 w-4" />开第一场
          </Button>}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pt-5 pb-4">
      {/* ── ① 项目头 ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative">
            <button
              onClick={() => setProjOpen(v => !v)}
              className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-primary shadow-xs transition-colors hover:border-line-strong"
            >
              {ws.label}
              <ChevronDown className="h-3.5 w-3.5 text-tertiary" />
            </button>
            {projOpen && (
              <div className="animate-enter absolute left-0 top-full z-30 mt-1 w-56 rounded-lg border border-line bg-surface p-1 shadow-lg">
                {projects.map(p => (
                  <button key={p.id}
                    onClick={() => void pickProject(p.id)}
                    className={cn('block w-full rounded-md px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-2',
                      p.id === ws.id ? 'font-medium text-accent-text' : 'text-secondary')}
                  >{p.label}</button>
                ))}
                <button
                  onClick={() => void createProject()}
                  className="mt-1 block w-full rounded-md border-t border-line px-3 py-1.5 text-left text-[13px] text-accent-text hover:bg-surface-2"
                >+ 新建项目</button>
              </div>
            )}
          </div>
        </div>
        <span className="text-[11px] text-tertiary tabular-nums">
          {lastEventTs ? `SSE 实时 · 最近事件 ${timeAgo(lastEventTs)}` : 'SSE 实时'}
        </span>
      </div>

      {/* ── ② 战役卡片 ── */}
      <div className="flex flex-wrap gap-3">
        {engagements?.map(eng => {
          const duration = eng.oldestTs
            ? Math.floor((Date.now() - Date.parse(eng.oldestTs)) / 60_000)
            : 0;
          const durStr = duration >= 60 ? `${Math.floor(duration / 60)}h${duration % 60}m` : `${duration}min`;
          const orch = eng.sessions.find(s => s.agentKey === 'autopwn');
          return (
            <button key={eng.engagementId}
              onClick={() => goAutopwn(orch?.id)}
              className="group flex min-w-[220px] flex-col gap-2 rounded-lg border border-line bg-surface p-3.5 text-left shadow-xs transition-colors hover:border-line-strong hover:bg-surface-2"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-[13px] font-medium text-primary">
                  {eng.engagementId}
                </span>
                <span className="font-mono text-[11px] text-tertiary tabular-nums">{durStr}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                {eng.sessions.slice(0, 6).map(s => (
                  <span key={s.id} className="flex items-center gap-1">
                    <Dot tone={s.busy ? 'accent' : 'neutral'} pulse={s.busy} />
                    <span className="text-[11px] text-secondary">
                      {s.spawnName ?? s.agentKey}
                    </span>
                  </span>
                ))}
                {eng.sessions.length > 6 && (
                  <span className="text-[11px] text-faint">+{eng.sessions.length - 6}</span>
                )}
              </div>
              <span className="text-[11px] text-tertiary">
                {eng.busyCount}/{eng.sessions.length} 席运行中
              </span>
            </button>
          );
        })}
        {/* + 新开战役 */}
        <button
          onClick={() => goAutopwn()}
          className="flex min-w-[160px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line bg-surface/50 p-3.5 text-center transition-colors hover:border-line-strong hover:bg-surface-2"
        >
          <Plus className="h-5 w-5 text-tertiary" />
          <span className="text-[13px] text-secondary">新开战役</span>
        </button>
      </div>

      {/* ── ③④ 战果区(环形图 + 最近发现) ── */}
      <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* 左: 环形图 + KPI */}
        <div className="flex flex-col items-center gap-4 rounded-lg border border-line bg-surface p-5 shadow-xs">
          {totalVulns > 0 ? (
            <div className="relative">
              <svg viewBox="0 0 200 200" className="w-[200px] h-[200px]">
                <circle cx="100" cy="100" r="70" fill="none"
                  stroke="var(--surface-3)" strokeWidth="18" />
                {segments.map(s => (
                  <path key={s.id} d={s.path} fill="none"
                    stroke={SEV_COLOR[s.id]} strokeWidth="18" strokeLinecap="butt"
                    className="cursor-pointer transition-opacity duration-150"
                    style={{ opacity: hoveredSev && hoveredSev !== s.id ? 0.3 : 1 }}
                    onMouseEnter={() => setHoveredSev(s.id)}
                    onMouseLeave={() => setHoveredSev(null)}
                  />
                ))}
              </svg>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-[36px] font-bold leading-none tabular-nums text-primary">
                  {centerCount}
                </span>
                <span className="mt-1.5 text-[11px] text-tertiary">{centerLabel}</span>
              </div>
            </div>
          ) : (
            <div className="flex h-[200px] items-center justify-center">
              <span className="text-[13px] text-tertiary">尚无漏洞发现</span>
            </div>
          )}
          {/* KPI 行 */}
          <div className="flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1 text-[13px] text-tertiary">
            <span>资产 <b className="font-semibold text-primary tabular-nums">{kpi.scope}</b></span>
            <span aria-hidden="true">·</span>
            <span>情报 <b className="font-semibold text-primary tabular-nums">{kpi.intel}</b></span>
            <span aria-hidden="true">·</span>
            <span>终报 <b className="font-semibold text-primary tabular-nums">{kpi.reports}</b>
              {kpi.failed > 0 && <span className="ml-0.5 text-danger-text">({kpi.failed} 失败)</span>}
            </span>
          </div>
        </div>

        {/* 右: 最近发现 */}
        <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-4 shadow-xs">
          <p className="text-[11px] font-medium tracking-wide text-tertiary">最近发现</p>
          {recentVulns.length === 0 ? (
            <div className="flex flex-1 items-center justify-center py-8">
              <span className="text-[13px] text-tertiary">尚无漏洞——席位正在工作中</span>
            </div>
          ) : recentVulns.map(v => {
            const sev = (v.current?.severity ?? v.severity ?? 'info').toLowerCase();
            return (
              <button key={v.seq}
                onClick={() => { window.location.hash = '#/audit'; }}
                className="block w-full rounded-md p-2 text-left transition-colors hover:bg-surface-2"
              >
                <div className="flex items-center gap-2">
                  <SeverityBadge severity={sev} />
                  <span className="flex-1 truncate text-[13px] text-primary">
                    {v.current?.title ?? v.title}
                  </span>
                </div>
                <span className="mt-0.5 block text-[11px] text-tertiary">
                  {v.from} · {v.ts ? timeAgo(v.ts) : ''}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── ⑤ 活动流 ── */}
      <div className="flex flex-col rounded-lg border border-line bg-surface shadow-xs">
        <header className="flex h-10 shrink-0 items-center border-b border-line bg-surface-2/50 px-4">
          <h3 className="text-sm font-semibold text-primary">活动流</h3>
        </header>
        <div className="max-h-[160px] space-y-1 overflow-y-auto p-3">
          {activities.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-tertiary">暂无活动</p>
          ) : activities.map(a => {
            const e = a.current ?? a;
            const type = e.type ?? '';
            return (
              <div key={a.seq} className="flex items-baseline gap-2 text-[12px]">
                <span className={cn('w-0.5 shrink-0 self-stretch rounded-full', ACTIVITY_BAR[type] ?? 'bg-line')} />
                <span className="shrink-0 font-mono text-[11px] text-faint tabular-nums">
                  {e.ts ? localTime(e.ts) : ''}
                </span>
                <span className="shrink-0 text-[11px] font-medium text-accent-text">
                  {e.from}
                </span>
                <span className="truncate text-secondary">
                  {e.title ?? e.summary ?? ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
