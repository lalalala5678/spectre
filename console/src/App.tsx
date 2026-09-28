import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { AgentWorkspacePage, getAgent } from './pages/AgentWorkspacePage';
import { SkillsPage } from './pages/SkillsPage';
import { McpPage } from './pages/McpPage';
import { CliPage } from './pages/CliPage';
import SettingsPage from './pages/SettingsPage';
import { getPrefs } from './api/worksession';
import { AuditPage } from './pages/AuditPage';
import ShellPage from './pages/ShellPage';
import { TaskReportsPage } from './pages/TaskReportsPage';
import type { RouteKey } from './types';

const STAGE_ROUTES: RouteKey[] = [
  'autopwn', 'recon', 'nday', 'weakcred', 'api', 'exploit', 'phish', 'c2', 'persistence', 'postex', 'report',
];

const AGENT_OF_ROUTE: Record<string, string> = {
  autopwn: 'autopwn',
  recon: 'recon',
  nday: 'nday',
  weakcred: 'weakcred',
  api: 'api',
  exploit: 'exploit',
  phish: 'phish',
  c2: 'c2',
  persistence: 'persistence',
  postex: 'postex',
  report: 'report',
};

export default function App() {
  const [route, setRoute] = useState<RouteKey>(() => {
    const h = window.location.hash.replace('#', '') as RouteKey;
    const valid: RouteKey[] = [...STAGE_ROUTES, 'reports', 'skills', 'mcp', 'cli', 'audit', 'shells', 'settings'];
    return valid.includes(h) ? h : 'autopwn';
  });

  const nav = (r: RouteKey) => {
    setRoute(r);
    window.location.hash = r;
  };

  // F57: hash deep-links / browser back-forward used to only work at
  // first mount — the route was read once in useState and never updated
  // on later hash changes (manual URL edits, history navigation).
  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.replace('#', '') as RouteKey;
      const valid: RouteKey[] = [...STAGE_ROUTES, 'reports', 'skills', 'mcp', 'cli', 'audit', 'shells', 'settings'];
      setRoute(valid.includes(h) ? h : 'autopwn');
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const [wsId, setWsId] = useState<string | null>(null);
  useEffect(() => {
    getPrefs().then(p => setWsId(p.currentWs)).catch(() => {});
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-void-950 font-sans text-slate-200">
      <Sidebar route={route} onRoute={nav} runningCount={1} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="min-h-0 flex-1 overflow-hidden bg-void-950">
          {STAGE_ROUTES.includes(route) ? (
            <AgentWorkspacePage key={route} agent={getAgent(AGENT_OF_ROUTE[route])} />
          ) : route === 'skills' ? (
            <div className="h-full overflow-hidden p-4">
              {wsId === null
                ? <p className="animate-pulse py-10 text-center text-[11px] text-zinc-600">正在加载项目信息…</p>
                : wsId ? <SkillsPage wsId={wsId} /> : <p className="py-10 text-center text-[11px] text-zinc-600">无当前项目,请先在顶栏选择</p>}
            </div>
          ) : route === 'mcp' ? (
            <div className="h-full overflow-hidden p-4">
              {wsId === null
                ? <p className="animate-pulse py-10 text-center text-[11px] text-zinc-600">正在加载项目信息…</p>
                : wsId ? <McpPage wsId={wsId} /> : <p className="py-10 text-center text-[11px] text-zinc-600">无当前项目,请先在顶栏选择</p>}
            </div>
          ) : route === 'cli' ? (
            <div className="h-full overflow-hidden p-4">
              {wsId === null
                ? <p className="animate-pulse py-10 text-center text-[11px] text-zinc-600">正在加载项目信息…</p>
                : wsId ? <CliPage wsId={wsId} /> : <p className="py-10 text-center text-[11px] text-zinc-600">无当前项目,请先在顶栏选择</p>}
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
