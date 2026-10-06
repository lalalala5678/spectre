import { ShieldCheck } from 'lucide-react';
/**
 * r47c: 渗透授权确认卡(用户令: **在主控会话消息流里**弹出的交互消息——
 * 非页面横幅)。pending 授权请求存在时渲染于消息流底部(busy 提示前),
 * 形态与对话气泡同族; 确认后写入 targets+时间窗并全程不再分心授权。
 */
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button } from '../ui/Button';

/**
 * 项目隔离: 只显示当前项目(workSessionId)的授权请求——授权信息与其
 * 它信息一样是项目内信息, 切换项目即不可见(用户令: 新建项目曾被
 * 全局 pending 弹卡)。
 */
export function ScopeAuthCard({ wsId }: { wsId: string | null }) {
  const [pending, setPending] = useState<{ seq: number; target: string; reason: string; from: string; requester?: string; workSessionId?: string | null }[]>([]);
  const [busy, setBusy] = useState(false);
  const [start, setStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [end, setEnd] = useState(() => new Date(Date.now() + 7 * 86400e3).toISOString().slice(0, 10));
  const load = () => api<typeof pending>('/scope/auth-requests')
    .then(list => setPending(list.filter(r => (r.workSessionId ?? null) === (wsId ?? null))))
    .catch(() => {});
  useEffect(() => {
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  if (pending.length === 0) return null;
  const targets = [...new Set(pending.map(r => r.target))];
  const act = async (kind: 'approve' | 'reject') => {
    setBusy(true);
    try {
      for (const r of pending) {
        await api(`/scope/auth-requests/${r.seq}/${kind}`, {
          method: 'POST',
          json: kind === 'approve'
            ? { windowStart: new Date(start).toISOString(), windowEnd: new Date(end + 'T23:59:59').toISOString() }
            : {},
        });
      }
      await load();
    } finally { setBusy(false); }
  };
  return (
    <div className="my-2 max-w-[92%] rounded-lg border border-accent-line bg-accent-subtle/60 px-3 py-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-accent-text">
        <ShieldCheck className="h-3.5 w-3.5" />
        <span>渗透授权确认</span>
      </div>
      <p className="text-sm leading-relaxed text-primary">请确认你是否拥有对以下 scope 的渗透测试授权:</p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {targets.map(t => (
          <li key={t} className="rounded-full border border-line-strong bg-surface px-2 py-0.5 font-mono text-xs text-secondary">{t}</li>
        ))}
      </ul>
      {pending[0]?.reason && <p className="mt-1.5 text-xs leading-snug text-tertiary">申请理由: {pending[0].reason}</p>}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <span className="text-xs text-tertiary">授权期限</span>
        <input type="date" value={start} onChange={e => setStart(e.target.value)}
          className="h-7 rounded-md border border-line bg-surface px-2 text-xs" />
        <span className="text-xs text-tertiary">至</span>
        <input type="date" value={end} onChange={e => setEnd(e.target.value)}
          className="h-7 rounded-md border border-line bg-surface px-2 text-xs" />
        <span className="flex-1" />
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => act('reject')}>失败</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => act('approve')}>确认授权</Button>
      </div>
    </div>
  );
}
