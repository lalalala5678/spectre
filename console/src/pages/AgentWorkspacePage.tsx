import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRightLeft, ChevronDown, CornerUpLeft, Cpu, History, Play, Plus, Trash2 } from 'lucide-react';
import type { AgentMeta } from '../types';
import { api, type ApiBusEvent, type ApiSessionSummary } from '../api/client';
import { Dot } from '../components/ui/Badge';

import { Panel } from '../components/ui/Panel';
import { PanelStack } from '../components/ui/PanelStack';
import { LiveSession } from '../components/session/LiveSession';
import { VulnPanel } from '../components/session/VulnPanel';
import { SessionsPanel } from '../components/session/SessionsPanel';
import { EntryDetail } from '../components/session/EntryDetail';
import { DispatchTreePanel } from '../components/session/DispatchTreePanel';
import { TaskReportsPanel } from '../components/session/TaskReportsPanel';
import { IntelNotesPanel } from '../components/session/IntelNotesPanel';
import { PhishCampaignsPanel } from '../components/session/PhishCampaignsPanel';
import { BusView } from './BusView';
import { cn } from '../utils/cn';
import {
  deleteWorkSession, ensureWorkSession, listWorkSessions, newWorkSession, switchWorkSession,
  setLastSession, putPrefsSync, getPrefs, cnNumber, type WorkSession,
} from '../api/worksession';
import { takePendingOpen, OPEN_SESSION_EVENT } from '../api/openSessionChannel';
// CS44-F17: 三组件拆出 components/agent/(905 行四职责收敛, 先例 nav.ts)
import { AgentConfigTab } from '../components/agent/AgentConfigTab';

// Right column: proportional width (vw), never a fixed pixel band — adapts
// to any screen. The user preference is a RATIO, so a width dragged on one
// monitor re-proportions on another. No artificial limits: only a physical
// guard so elements stay interactive.
const DEFAULT_RIGHT_RATIO = 0.24;

const errText = (e: unknown) => String(e instanceof Error ? e.message : e);

/** 单个 Agent 工作台页（资产测绘 / 漏洞挖掘 / … 共用骨架） */
export function AgentWorkspacePage({ agent }: { agent: AgentMeta }) {
  const liveKey = agent.id;  // CS3-N20: 恒等三元删除
  const [tab, setTab] = useState<'session' | 'bus' | 'config' | 'history'>('session');
  const [workSession, setWorkSession] = useState<WorkSession | null>(null);
  const [projects, setProjects] = useState<WorkSession[]>([]);
  // Server-side UI prefs mirror (panel ratios) — filled at boot.
  const uiPrefsRef = useRef<{ rightRatio?: number } | null>(null);
  // Boot: resolve the active project from the SERVER (prefs+registry);
  // the browser knows nothing. null → full-workspace loading skeleton.
  // R32D29-N4: 此前这里有两份逐字重复的 boot effect(ensureWorkSession
  // 双跑), 已合并为一份。
  const [uiReady, setUiReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // CS27-2: 每轮 boot 复位——bootDoneRef 此前只在首挂载置 true 后
    // 永不复位, 原地 re-boot(项目切换/重试)期间空态分支误放行可点
    // '新建会话'(与自动建会话竞争产重复空会话)。
    bootDoneRef.current = false;
    Promise.all([ensureWorkSession(), getPrefs()]).then(async ([ws, prefs]) => {
      if (cancelled) return;
      uiPrefsRef.current = prefs.ui ?? {};
      const saved = Number(prefs.ui?.rightRatio);
      if (saved > 0.02 && saved < 0.98) setRightRatio(saved);  // R13-F2
      setWorkSession(ws);
      setUiReady(true);
      setProjects(await listWorkSessions());
    }).catch(err => setWsError(errText(err)));
    return () => { cancelled = true; };
  }, []);

  const [mySessions, setMySessions] = useState<ApiSessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [drillSession, setDrillSession] = useState<string | null>(null);
  // R26(二十六轮): 全局搜索深链 #<agent>?s=<id>——Topbar 点击直达目标
  // 会话(裸会话/跨项目/同项目记忆竞态三场景统一由此打开)。
  const readDeepLink = () =>
    new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('s');
  const [deepLink, setDeepLink] = useState<string | null>(readDeepLink);

  // R26(二十七轮修订): 深链消费走 drill 通道——setDrillSession(id)
  // 本就是"渲染任意会话转录"的既有机制(EntryDetail onOpenSession 同路)。
  // ref 镜像: boot 的乐观清场据此保留深链(N1 时序竞争修复)。
  const deepLinkRef = useRef<string | null>(null);
  const bootDoneRef = useRef(false);  // R32D32-R3: 在位点击不再写 deepLinkRef 的判据
  // R32D29-N2: 应用内点击走 pendingOpen 通道(不走 hash——旧页消费
  // effect 会抢在路由提交前洗掉 ?s=, fiber 实锤 ≈50% 丢目标); 冷
  // 加载/URL 直达仍走 ?s=(仅挂载时一次性读)。ref 只在此写入, 由
  // boot 首次运行末尾清零(R28-N1 pending 模型)。
  // CS22-F3/F8: drill 开/关对称——开写 ?s=drill 目标, 关回写主会话。
  // 此前入口一半同步(consumePending/closeDrill)一半裸 setDrillSession
  // (四处页内入口), 且「返回主控会话」按钮绕过 closeDrill。
  const openDrill = useCallback((id: string) => {
    setEntryView(null);  // CS23-N18: 收编六入口的前置清场(不对称消除)
    setDrillSession(id);
    history.replaceState(null, '', `${window.location.pathname}#${liveKey}?s=${id}`);
  }, [liveKey]);
  const closeDrill = useCallback(() => {
    setDrillSession(null);
    // R32D47-P2: 返回主控会话时 ?s= 同步回当前主会话(与切换同口径)。
    // CS23-N19: 无主会话(边缘)时剥掉 ?s= 而非残留指向已关 drill。
    if (sessionId) {
      history.replaceState(null, '', `${window.location.pathname}#${liveKey}?s=${sessionId}`);
    } else {
      history.replaceState(null, '', `${window.location.pathname}#${liveKey}`);
    }
  }, [liveKey, sessionId]);

  const consumePending = useCallback(() => {
    const id = takePendingOpen(liveKey);
    if (!id) return;
    // R32D32-R3: ref 只在 boot 未完成的挂载窗口写入(供乐观清场保留
    // drill + R28-N2 跳过误建); 组件已在位(boot 已跑完)时写 ref 会
    // 让下一次项目切换复用旧 drill 并抑制新项目锚点(跨项目残留)。
    if (!bootDoneRef.current) deepLinkRef.current = id;
    openDrill(id);
  }, [liveKey, openDrill]);
  useEffect(() => {
    if (deepLink) {
      deepLinkRef.current = deepLink;
      setDrillSession(deepLink);
      // R32D45-N2: 同款不再清洗——挂载期保留 ?s= 使历史条目可重访。
      setDeepLink(null);  // 重入以挂接下方通道监听
    } else {
      consumePending();
    }
    window.addEventListener(OPEN_SESSION_EVENT, consumePending);
    return () => window.removeEventListener(OPEN_SESSION_EVENT, consumePending);
  }, [deepLink, consumePending]);
  const [entryView, setEntryView] = useState<ApiBusEvent | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [projectName, setProjectName] = useState('');

  const [naming, setNaming] = useState(false);
  const isAuto = agent.id === 'autopwn';
  const [bootstrapNonce, setBootstrapNonce] = useState(0);
  const [wsError, setWsError] = useState('');

  // Enter workspace (or switch work session / agent): restore the
  // remembered conversation of this agent INSIDE the current work session,
  // else the latest, else create one. Engagement children, runtime-spawned
  // descendants (parentSessionId) and other work sessions' conversations
  // are NEVER candidates — spawned nodes live in the dispatch tree
  // (reachable via drill) and left-sidebar workspaces are independent of
  // AutoPwn and of sibling tasks.
  useEffect(() => {
    if (!workSession) return;  // still resolving the project (server boot)
    const ws = workSession;
    // Optimistic clear (project-switch perceived latency): the OLD
    // project's transcript used to linger until this async finished —
    // clear the stage synchronously so the skeleton shows immediately.
    // R27-N1: 深链在场时不得清——boot 的乐观清场此前把刚消费的
    // setDrillSession(id) 同步覆写(跨 agent 新挂载路径深链必丢)。
    setDrillSession(deepLinkRef.current);
    setWsError('');
    setEntryView(null);
    setMySessions([]);
    setSessionId(null);
    // Race guard: rapid project switches fire overlapping bootstraps;
    // the stale response must never overwrite the newer one.
    let cancelled = false;
    (async () => {
      const all = await api<ApiSessionSummary[]>(`/sessions?workSessionId=${encodeURIComponent(ws.id)}`);
      if (cancelled) return;
      const mine = all.filter(s =>
        s.agentKey === liveKey && !s.engagementId && !s.parentSessionId
        && s.workSessionId === ws.id,
      );
      // remembered conversation lives on the project record (server)
      const remembered = ws.lastSessions?.[liveKey] ?? null;
      const restored = remembered && mine.find(s => s.id === remembered);
      if (restored) {
        if (cancelled) return;
        setMySessions(mine);
        setSessionId(restored.id);
      } else if (mine.length > 0) {
        if (cancelled) return;
        const latest = mine[mine.length - 1].id;
        void setLastSession(ws.id, liveKey, latest); // heal stale
        setMySessions(mine);
        setSessionId(latest);
      } else if (deepLinkRef.current) {
        // R27-N2: 深链在场(正在拉目标)——跳过新建, 杜绝每次点击
        // 遗留 0-msg 空会话污染
        setMySessions([]);
        setSessionId(null);
      } else {
        const created = await api<ApiSessionSummary>('/sessions', {
          method: 'POST',
          json: { agentKey: liveKey, workSessionId: ws.id },
        });
        if (cancelled) return;
        void setLastSession(ws.id, liveKey, created.id);
        setMySessions([created]);
        setSessionId(created.id);
      }
      // R28-N1: 深链在场到此结束——boot 全路径走完后清 ref, 后续
      // 项目切换/agent 切换的乐观清场恢复正常语义。
      deepLinkRef.current = null;
      bootDoneRef.current = true;  // R32D32-R3
    })().catch((err: unknown) => {
      // Bootstrap failures (runtime down, auth expired, …) must surface —
      // never a silent empty workspace. CS27-2: 失败也算 boot 完成——
      // 空态分支此前永久 pulse '正在准备会话…'(状态谎报)。
      bootDoneRef.current = true;
      if (!cancelled) setWsError(errText(err));
    });
    return () => { cancelled = true; };
  }, [workSession, liveKey, bootstrapNonce]);

  // Keep the sessions panel live: the runtime generates title/brief a few
  // seconds after each exchange — without polling the panel stays on the
  // bootstrap snapshot forever.
  // 语义键=ws.id(先取标量, effect 内不引用 workSession 整对象——
  // 对象每轮快照重建, 入 deps 会每 4s 拆装定时器)
  const panelWsId = workSession?.id;
  useEffect(() => {
    if (!panelWsId) return;
    const wsId = panelWsId;
    let stopped = false;
    const load = async () => {
      try {
        if (stopped) return;
        const all = await api<ApiSessionSummary[]>(`/sessions?workSessionId=${encodeURIComponent(wsId)}`);
        const mine = all.filter(s =>
          s.agentKey === liveKey && !s.engagementId && !s.parentSessionId
          && s.workSessionId === wsId,
        );
        // Dedup: identical content must not create a new array — poll
        // re-renders were the trigger of the scroll-jump class of bugs.
        setMySessions(prev => prev.length === mine.length
          && prev.every((s, i) => s.id === mine[i].id && s.title === mine[i].title
            && s.brief === mine[i].brief && s.busy === mine[i].busy
            && s.messages === mine[i].messages && s.spawnName === mine[i].spawnName)
          ? prev
          : mine);
      } catch { /* retry next tick */ }
    };
    const timer = setInterval(load, 4000);
    return () => { stopped = true; clearInterval(timer); };
  }, [liveKey, panelWsId]);

  const switchSession = (id: string) => {
    setSessionId(id);
    setDrillSession(null);
    setEntryView(null);
    setSwitcherOpen(false);
    // R32D46-NEW-4: 应用内切会话同步 ?s=——此前残留旧值, 刷新/复制链接
    // 打开的是旧会话(URL 与屏显脱钩)。replaceState 不增历史条目,
    // 后退重访语义不变。
    const base = window.location.hash.split('?')[0].replace('#', '') || liveKey;
    history.replaceState(null, '', `${window.location.pathname}#${base}?s=${id}`);
    void setLastSession(workSession!.id, liveKey, id);
  };

  /** New conversation ("会话N+1") for THIS agent inside the current task. */
  const newConversation = async () => {
    try {
      const created = await api<ApiSessionSummary>('/sessions', {
        method: 'POST',
        json: { agentKey: liveKey, workSessionId: workSession!.id },
      });
      setMySessions(prev => [...prev, created]);
      switchSession(created.id);
      setWsError('');
    } catch (err: unknown) {
      setWsError(errText(err));
    }
  };

  /** New project = user-named work session; every agent starts fresh. */
  const startNewProject = () => {
    const name = projectName.trim();
    if (!name) return;
    void newWorkSession(name).then(ws2 => setWorkSession(ws2));
    setProjectName('');
    setNaming(false);
    setSwitcherOpen(false);
  };

  // Right column width as a viewport ratio: user-draggable, persisted as a
  // ratio (adapts across monitors), CSS does all the math on resize.
  // R13-F2: 持久化读回——初始化器先于 boot effect 执行, ref 必 null
  // 恒走默认(只写不读)。改常量初始化 + boot then 内恢复。
  const [rightRatio, setRightRatio] = useState<number>(DEFAULT_RIGHT_RATIO);
  const dragW = useRef<{ startX: number; startW: number; moved: boolean } | null>(null);
  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragW.current = {
      startX: e.clientX,
      startW: e.currentTarget.parentElement!.getBoundingClientRect().width,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  /** A held session id died (runtime restart — known limitation #1).
   *  Drop the stale slot and re-bootstrap this workspace. */
  // 有意最小 deps 保稳定身份(见上方注释); workSession.id 变化由 bootstrapNonce 吸收
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleSessionGone = useCallback(() => {
    // server-side slot heals itself (bootstrap falls back to latest)
    setDrillSession(null);
    setEntryView(null);
    setSessionId(null);
    setBootstrapNonce(n => n + 1);
    // Stable identity: LiveSession's fetch effect depends on onGone — a
    // fresh function per render made it refetch (and scroll to bottom)
    // on every poll tick.
    // 有意最小 deps(见上注释); ws.id 变化由 bootstrapNonce 吸收
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workSession?.id, liveKey]);
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragW.current) return;
    const delta = dragW.current.startX - e.clientX;
    if (!dragW.current.moved && Math.abs(delta) < 3) return;  // stray click, not a drag
    dragW.current.moved = true;
    const ratio = (dragW.current.startW + delta) / window.innerWidth;
    setRightRatio(Math.min(0.98, Math.max(0.02, ratio)));
  };
  const onResizeUp = () => {
    if (dragW.current?.moved) {
      void putPrefsSync({ ui: { rightRatio } });
    }
    dragW.current = null;
  };
  const resetRightW = () => {
    void putPrefsSync({ ui: { rightRatio: DEFAULT_RIGHT_RATIO } });  // R13-F3
    setRightRatio(DEFAULT_RIGHT_RATIO);
  };
  const pickWorkSession = (id: string) => {
    void switchWorkSession(id).then(async next => {
      if (next) {
        setWorkSession(next);
        setProjects(await listWorkSessions());
      }
    });
    setSwitcherOpen(false);
  };

  // F58: delete a project from the switcher. Deleting the CURRENT
  // project falls back to the most recent remaining one (or creates a
  // fresh unnamed workspace so the console never dead-ends).
  const removeProject = (id: string, label: string) => {
    if (!window.confirm(`删除项目「${label}」?该操作不可撤销(会话历史保留,项目从列表移除)。`)) return;
    void (async () => {
      await deleteWorkSession(id);
      const rest = await listWorkSessions();
      setProjects(rest);
      if (workSession && workSession.id === id) {
        const next = rest.length ? rest[rest.length - 1] : await newWorkSession('');
        await switchWorkSession(next.id);
        setWorkSession(next);
      }
      setSwitcherOpen(false);
    })();
  };

  // Conversations sorted by creation → numbered names (会话一/二…),
  // independent per agent inside this work session.
  const namedSessions = [...mySessions]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((s, i) => ({ ...s, name: `会话${cnNumber(i + 1)}` }));
  const current = mySessions.find(s => s.id === (drillSession ?? sessionId));

  if (!workSession || !uiReady) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange-400" />
        <p className="animate-pulse text-[11.5px] text-zinc-500">正在载入项目…（服务端）</p>
        {wsError && <p className="text-[11px] text-red-400">{wsError}</p>}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 页头：agent 信息 + 会话控制 */}
      <div className="flex shrink-0 items-center gap-3 border-b border-void-700 bg-void-900 px-3.5 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold text-zinc-100">{agent.name}</h1>
            <span className="text-[11px] text-zinc-500">{agent.codename}</span>
            {/* F24: 删假 status/version(mock 硬编码,与真实会话态无关) */}
          </div>
          <p className="mt-px truncate text-[11px] text-zinc-600">{agent.desc}</p>
        </div>

        <div className="flex-1" />

        {/* 大会话(项目)切换 */}
        <div className="relative">
          <button
            onClick={() => setSwitcherOpen(v => !v)}
            className="flex items-center gap-2 rounded-sm border border-void-600 bg-void-800 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-void-700"
          >
            <Dot tone={current?.busy ? 'orange' : 'slate'} pulse={current?.busy} />
            <span className="max-w-56 truncate font-medium">{workSession.label}</span>
            <ChevronDown className="h-3.5 w-3.5 text-zinc-600" />
          </button>
          {switcherOpen && (
            <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded-sm border border-void-600 bg-void-900 p-1 shadow-lg">
              {naming ? (
                <div className="mb-1 flex gap-1">
                  <input
                    autoFocus
                    value={projectName}
                    onChange={e => setProjectName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') startNewProject();
                      if (e.key === 'Escape') setNaming(false);
                    }}
                    placeholder="项目名称…"
                    className="min-w-0 flex-1 rounded-sm border border-void-600 bg-void-950 px-2 py-1 text-[11px] text-zinc-200 outline-none focus:border-orange-700"
                  />
                  <button
                    onClick={startNewProject}
                    disabled={!projectName.trim()}
                    className="shrink-0 rounded-sm bg-orange-600 px-2 py-1 text-[10px] text-white disabled:opacity-40"
                  >
                    创建
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setNaming(true)}
                  className="mb-1 flex w-full items-center gap-1.5 rounded-sm bg-orange-600/90 px-2 py-1.5 text-[11px] font-medium text-white hover:bg-orange-500"
                >
                  <Plus className="h-3.5 w-3.5" /> 新项目
                </button>
              )}
              <div className="max-h-64 overflow-y-auto">
                {projects.slice().reverse().map((ws: WorkSession) => (
                  <div key={ws.id} className="group flex items-center gap-1">
                    <button
                      onClick={() => pickWorkSession(ws.id)}
                      className={cn(
                        'flex min-w-0 flex-1 items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-[11px] hover:bg-void-800',
                        ws.id === workSession.id ? 'text-zinc-100' : 'text-zinc-500',
                      )}
                    >
                      <span className="truncate">{ws.label}</span>
                      <span className="shrink-0 font-mono text-[9px] text-zinc-600">
                        {ws.createdAt.slice(5, 10)}
                      </span>
                    </button>
                    <button
                      title="删除项目"
                      onClick={e => { e.stopPropagation(); removeProject(ws.id, ws.label); }}
                      className="shrink-0 rounded-sm p-1 text-zinc-700 opacity-0 hover:bg-red-950 hover:text-red-400 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <button
          className="flex items-center gap-1 rounded-sm bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-500"
          onClick={() => { setSwitcherOpen(true); setNaming(true); }}
        >
          <Plus className="h-3.5 w-3.5" /> 新项目
        </button>
      </div>

      {wsError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-red-900 bg-red-950/40 px-3.5 py-1.5">
          <span className="font-mono text-[10px] uppercase tracking-widest text-red-400/80">
            操作失败
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-red-300">
            {wsError}
          </span>
          <button
            onClick={() => setWsError('')}
            className="shrink-0 rounded-sm border border-red-800 px-1.5 text-[10px] text-red-300 hover:bg-red-900/40"
          >
            关闭
          </button>
        </div>
      )}
      {/* Tab */}
      <div className="flex shrink-0 items-center gap-0.5 border-b border-void-700 bg-void-900 px-3.5 pt-1.5">
        {([
          ['session', '会话', Play],
          ...(isAuto ? [['bus', '消息总线', ArrowRightLeft] as const] : []),
          ['config', '配置', Cpu],
          ['history', '历史会话', History],
        ] as const).map(([k, label, Icon]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={cn(
              'flex items-center gap-1.5 rounded-t-sm border-b-2 px-3 py-1.5 text-[12px] transition-colors',
              tab === k
                ? 'border-orange-500 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300',
            )}
          >
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>

      {/* 内容：session tab 用固定骨架（运行流独立滚动 + 右栏固定），config/history 外层滚动 */}
      {tab === 'session' && (
        <div className="flex min-h-0 flex-1 gap-3 overflow-hidden p-3.5 pb-0">
          {/* 左：运行流（仅此处滚动） */}
          <section className="flex min-h-0 min-w-0 flex-1 flex-col rounded border border-void-700 bg-void-850 p-2.5">
            {entryView ? (
              <EntryDetail event={entryView} onBack={() => setEntryView(null)} onOpenSession={id => openDrill(id)} />
            ) : drillSession ? (
              <div className="flex min-h-0 flex-1 flex-col gap-2">
                <button
                  onClick={closeDrill}
                  className="flex w-fit items-center gap-1 rounded-sm border border-void-600 bg-void-800 px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200"
                >
                  <CornerUpLeft className="h-3 w-3" /> 返回主控会话
                </button>
                <LiveSession agentKey="__child__" sessionId={drillSession} onGone={closeDrill} />
              </div>
            ) : sessionId ? (
              <LiveSession agentKey={liveKey} sessionId={sessionId} onGone={handleSessionGone} />
            ) : !bootDoneRef.current ? (
              /* CS26-7: boot 在途(拉锚点/建会话中)——闪现'还没有主会话'
                 可点按钮会与 :180 自动建会话竞争产重复空会话。 */
              <div className="flex flex-1 items-center justify-center text-[12px] text-zinc-600 animate-pulse">正在准备会话…</div>
            ) : (
              /* R32D50-F6: 冷深链进入后 drill 关闭, 主会话可能尚未建——
                 此前渲染 LiveSession(null) 即 composer 静默 no-op+永久
                 loading 的死页。给明确的新建入口。 */
              <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
                <p className="text-[12.5px] text-zinc-400">本 agent 在当前项目还没有主会话</p>
                <button onClick={() => void newConversation()}
                  className="flex items-center gap-1.5 rounded-sm bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-500">
                  <Plus className="h-3.5 w-3.5" /> 新建会话
                </button>
              </div>
            )}
          </section>

          {/* 右栏：AutoPwn = 子Agent + 全量漏洞/情报;stage agent = 会话面板 + 自己的漏洞/情报 */}
          <div
            className="relative hidden min-h-0 shrink-0 xl:block"
            style={{ width: `${(rightRatio * 100).toFixed(2)}vw` }}
          >
            <div
              onPointerDown={onResizeDown}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeUp}
              onDoubleClick={resetRightW}
              title="拖动调整宽度 · 双击恢复默认"
              className="absolute -left-2 top-0 z-10 h-full w-4 cursor-col-resize after:absolute after:left-1/2 after:h-full after:w-px after:-translate-x-1/2 after:bg-void-700 after:transition-colors hover:after:bg-orange-600"
            />
            <div className="h-full pb-3.5">
              {isAuto ? (
                <PanelStack storageKey="spectre.panel.stackRatios.auto">
                  <DispatchTreePanel rootId={sessionId} activeId={drillSession} onDrill={id => openDrill(id)} />
                  <VulnPanel workSessionId={workSession.id} onOpen={setEntryView} onOpenSession={id => openDrill(id)} />
                  <IntelNotesPanel workSessionId={workSession.id} onOpen={setEntryView} />
                  <TaskReportsPanel workSessionId={workSession.id} onOpen={setEntryView} />
                </PanelStack>
              ) : (
                <PanelStack storageKey="spectre.panel.stackRatios.stage">
                  <SessionsPanel
                    sessions={namedSessions}
                    currentId={sessionId}
                    onSelect={switchSession}
                    onNew={newConversation}
                  />
                  <VulnPanel
                    agentKey={liveKey}
                    workSessionId={workSession.id}
                    onOpen={setEntryView}
                    onOpenSession={id => openDrill(id)}
                  />
                  <IntelNotesPanel
                    agentKey={liveKey}
                    workSessionId={workSession.id}
                    onOpen={setEntryView}
                  />
                  {agent.id === 'phish' && <PhishCampaignsPanel />}
                </PanelStack>
              )}
            </div>
          </div>
        </div>
      )}

      {tab !== 'session' && (
        <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
          {tab === 'bus' && isAuto && <BusView workSessionId={workSession.id} />}
          {tab === 'config' && (
            <AgentConfigTab agentId={agent.id} isAuto={isAuto} />
          )}

          {tab === 'history' && (
            <Panel title="历史会话" bodyClassName="p-0" className="w-full">
              <div className="divide-y divide-void-700">
                {/* F22: 原为硬编码 mock(死链无 onClick)。接 mySessions 真数据,
                    点击下钻该会话只读详情(drill 机制已有)。 */}
                {mySessions.length === 0 ? (
                  <div className="px-3 py-4 text-[11.5px] text-zinc-500">本项目该 agent 暂无历史会话。</div>
                ) : [...mySessions].reverse().slice(0, 30).map(s => (
                  <button key={s.id}
                    onClick={() => { setTab('session'); openDrill(s.id); }}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-void-800/60">
                    <Dot tone={s.busy ? 'orange' : 'cyan'} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-medium text-zinc-200">
                        {s.title || '(未命名会话)'}
                      </div>
                      <div className="font-mono text-[10px] text-zinc-600">
                        {s.id} · {new Date(s.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                    <span className={cn('shrink-0 text-[10px]', s.busy ? 'text-orange-400' : 'text-zinc-500')}>
                      {s.busy ? 'busy' : 'done'}
                    </span>
                  </button>
                ))}
              </div>
            </Panel>
          )}
        </div>
      )}

    </div>
  );
}
