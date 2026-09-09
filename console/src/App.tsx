import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { AgentWorkspacePage, getAgent } from './pages/AgentWorkspacePage';
import { SkillsPage } from './pages/SkillsPage';
import { McpPage } from './pages/McpPage';
import { CliPage } from './pages/CliPage';
import { getPrefs } from './api/worksession';
import { AuditPage } from './pages/AuditPage';
import type { RouteKey } from './types';

const STAGE_ROUTES: RouteKey[] = [
  'autopwn', 'recon', 'nday', 'weakcred', 'api', 'exploit', 'phish', 'c2', 'persistence', 'postex', 'report',
];

const AGENT_OF_ROUTE: Record<string, string> = {
  autopwn: 'orchestrator',
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
    const valid: RouteKey[] = [...STAGE_ROUTES, 'skills', 'mcp', 'cli', 'audit'];
    return valid.includes(h) ? h : 'autopwn';
  });

  const nav = (r: RouteKey) => {
    setRoute(r);
    window.location.hash = r;
  };

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
            <div className="h-full overflow-hidden p-4"><SkillsPage wsId={wsId ?? ''} /></div>
          ) : route === 'mcp' ? (
            <div className="h-full overflow-hidden p-4"><McpPage wsId={wsId ?? ''} /></div>
          ) : route === 'cli' ? (
            <div className="h-full overflow-hidden p-4"><CliPage wsId={wsId ?? ''} /></div>
          ) : (
            <div className="h-full overflow-y-auto p-4"><AuditPage /></div>
          )}
        </main>
      </div>
    </div>
  );
}
