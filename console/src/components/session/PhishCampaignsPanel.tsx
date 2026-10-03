import { useEffect, useState } from 'react';
import { Fish } from 'lucide-react';

import { api } from '../../api/client';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';

/** F62: /api/phish/campaigns 后端聚合(GoPhish 漏斗/转化率/时间线)一直
 * 存在但前端零消费——钓鱼效果在 UI 完全不可见。挂在 Phish 工作区右栏。 */
interface Campaign {
  name: string;
  events: number;
  targets: number;
  funnel: { opens: number; clicks: number; submits: number; sessions: number };
  rates: { open: number; click: number; submit: number; session: number };
  timeline: Array<{ ts: string; kind: string; uid: string }>;
}

const KIND_LABEL: Record<string, string> = {
  open: '打开', click: '点击', submit: '提交', session: '会话',
  sent: '送达', bounce: '退信',
};

function pct(n: number) { return `${Math.round(n)}%`; }

export function PhishCampaignsPanel() {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let stopped = false;
    const load = () => api<{ campaigns: Campaign[] }>('/phish/campaigns')
      .then(d => { if (!stopped) setCampaigns(d.campaigns ?? []); })
      .catch(e => { if (!stopped) setErr(e instanceof Error ? e.message : String(e)); });
    load();
    const t = setInterval(load, 30_000);
    return () => { stopped = true; clearInterval(t); };
  }, []);

  return (
    <div className="animate-enter flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-surface shadow-xs">
      <header className="flex items-center justify-between gap-2 border-b border-line bg-surface-2/50 px-3 py-1.5">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-secondary">
          <Fish className="h-3.5 w-3.5 text-tertiary" />钓鱼漏斗
        </h3>
        <span className="text-xs tabular-nums text-tertiary">{campaigns?.length ?? '…'}</span>
      </header>
      <div className="flex-1 space-y-1 overflow-y-auto p-2" tabIndex={0} aria-label="钓鱼活动列表">
        {err && <p className="p-2 text-sm text-danger-text">加载失败:{err}</p>}
        {!err && campaigns === null && (
          <Skeleton className="mx-1 my-2 h-11" />
        )}
        {!err && campaigns?.length === 0 && (
          <EmptyState icon={Fish} title="暂无 campaign" hint="Phish agent 发起后在此聚合" />
        )}
        {campaigns?.map(c => (
          <div key={c.name} className="min-h-11 rounded-md border border-line bg-surface px-2 py-1.5 hover:bg-surface-2">
            <div className="flex items-center justify-between">
              <span className="truncate text-sm font-medium text-primary">{c.name}</span>
              <span className="text-xs tabular-nums text-tertiary">{c.targets} 目标 · {c.events} 事件</span>
            </div>
            {/* 漏斗: opens → clicks → submits → sessions */}
            <div className="mt-1 flex items-center gap-1 text-xs tabular-nums">
              {([['open', c.funnel.opens, c.rates.open],
                 ['click', c.funnel.clicks, c.rates.click],
                 ['submit', c.funnel.submits, c.rates.submit],
                 ['session', c.funnel.sessions, c.rates.session]] as const).map(([k, n, r], i) => (
                <span key={k} className="flex items-center gap-1">
                  {i > 0 && <span className="text-faint">→</span>}
                  <span className={n > 0 ? 'text-success-text' : 'text-tertiary'}>
                    {KIND_LABEL[k] ?? k} {n}{n > 0 && r > 0 ? `(${pct(r)})` : ''}
                  </span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
