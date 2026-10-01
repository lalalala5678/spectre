import { useEffect, useState } from 'react';
import { api } from './api/client';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { AgentWorkspacePage } from './pages/AgentWorkspacePage';
import { getAgent } from './api/agentMeta';
import { SkillsPage } from './pages/SkillsPage';
import { McpPage } from './pages/McpPage';
import { CliPage } from './pages/CliPage';
import { SettingsPage } from './pages/SettingsPage';
import { getPrefs } from './api/worksession';
import { AuditPage } from './pages/AuditPage';
import { ShellPage } from './pages/ShellPage';
import { TaskReportsPage } from './pages/TaskReportsPage';
import type { RouteKey } from './types';
import { setPendingOpen } from './api/openSessionChannel';

const STAGE_ROUTES: RouteKey[] = [
  'autopwn', 'recon', 'nday', 'weakcred', 'api', 'exploit', 'phish', 'c2', 'persistence', 'postex', 'report',
];
// R32D39-N1: 配置三键也是 agent 会话——此前不进路由表, 全局搜索点击
// 这些会话时 pendingOpen 无人消费, 静默死路到 autopwn 页(README 承诺
// '任何 agent 的会话均可打开'被证伪)。
const CONFIG_AGENT_ROUTES: RouteKey[] = ['skill-config', 'mcp-config', 'cli-config'];

export default function App() {
  const [route, setRoute] = useState<RouteKey>(() => {
    // R26: hash 可携带 ?s=<sessionId> 深链——路由只取 base 段
    const h = window.location.hash.replace('#', '').split('?')[0] as RouteKey;
    const valid: RouteKey[] = [...STAGE_ROUTES, ...CONFIG_AGENT_ROUTES, 'reports', 'skills', 'mcp', 'cli', 'audit', 'shells', 'settings'];
    return valid.includes(h) ? h : 'autopwn';
  });

  const nav = (r: RouteKey) => {
    setRoute(r);
    window.location.hash = r;
  };

  // F71: 侧栏 autopwn 运行点此前硬编码 runningCount={1}——恒亮假
  // "运行中"。改真数据: 轻投影 tree 轮询 busy 会话数(20s)。
  const [runningCount, setRunningCount] = useState(0);
  useEffect(() => {
    let stopped = false;
    const poll = () => api<{ busy: boolean; agentKey: string; engagementId?: string | null }[]>('/sessions/tree')
      // R13-F5: 徽标在 autopwn 导航项——只计 autopwn 会话与 engagement
      // 子会话(此前任意 stage agent busy 都点亮 AutoPwn '运行中')。
      .then(t => { if (!stopped) setRunningCount(t.filter(s => s.busy
        && (s.agentKey === 'autopwn' || s.engagementId)).length); })
      .catch(() => {});
    poll();
    const timer = setInterval(poll, 20_000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);

  // F57: hash deep-links / browser back-forward used to only work at
  // first mount — the route was read once in useState and never updated
  // on later hash changes (manual URL edits, history navigation).
  useEffect(() => {
    const onHash = () => {
      const raw = window.location.hash.replace('#', '');
      // R32D30-E3: 应用已开时地址栏粘贴 #agent?s=id 此前只切路由不
      // drill(?s= 仅挂载时读一次)。这里把参数转发到 pendingOpen 通道
      // ——与搜索点击同一消费路径, 并 replaceState 清洗地址栏。
      const s = new URLSearchParams(raw.split('?')[1] ?? '').get('s');
      const h = raw.split('?')[0] as RouteKey;
      const valid: RouteKey[] = [...STAGE_ROUTES, ...CONFIG_AGENT_ROUTES, 'reports', 'skills', 'mcp', 'cli', 'audit', 'shells', 'settings'];
      if (s && valid.includes(h)) {
        setPendingOpen(h, s);
        history.replaceState(null, '', `${window.location.pathname}#${h}`);
      }
      const resolved = valid.includes(h) ? h : 'autopwn';
      setRoute(resolved);
      // R32D41-N4: 无效 hash 此前渲染回落 autopwn 但地址栏保留垃圾
      // 路由名——补 replaceState 清洗(与 ?s= 分支同款)。
      if (!valid.includes(h)) {
        history.replaceState(null, '', `${window.location.pathname}#${resolved}`);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const [wsId, setWsId] = useState<string | null>(null);
  // R13-F1: 依赖 [route]——项目切换只写服务端 prefs, App 层 wsId 此前
  // 是启动快照永不刷新, skills/mcp/cli 页持续作用于旧项目(跨项目错写)。
  useEffect(() => {
    getPrefs().then(p => setWsId(p.currentWs ?? '')).catch(() => {});  // R16-F3
  }, [route]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-void-950 font-sans text-slate-200">
      <Sidebar route={route} onRoute={nav} runningCount={runningCount} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="min-h-0 flex-1 overflow-hidden bg-void-950">
          {[...STAGE_ROUTES, ...CONFIG_AGENT_ROUTES].includes(route) ? (
            <AgentWorkspacePage key={route} agent={getAgent(route)} />
          ) : ['skills', 'mcp', 'cli'].includes(route) ? (
            // CS1-R9: 三配置页同构外壳收敛(页面组件查表)
            <div className="h-full overflow-hidden p-4">
              {wsId === null
                ? <p className="animate-pulse py-10 text-center text-[11px] text-zinc-600">正在加载项目信息…</p>
                : wsId
                  ? (route === 'skills' ? <SkillsPage wsId={wsId} />
                    : route === 'mcp' ? <McpPage wsId={wsId} />
                    : <CliPage wsId={wsId} />)
                  : <p className="py-10 text-center text-[11px] text-zinc-600">无当前项目,请先在顶栏选择</p>}
            </div>
          ) : route === 'shells' ? (
            <ShellPage />
          ) : route === 'settings' ? (
            <div className="h-full overflow-y-auto"><SettingsPage /></div>
          ) : route === 'reports' ? (
            <div className="h-full overflow-hidden p-4"><TaskReportsPage /></div>
          ) : (
            <div className="h-full overflow-y-auto p-4"><AuditPage /></div>
          )}
        </main>
      </div>
    </div>
  );
}
