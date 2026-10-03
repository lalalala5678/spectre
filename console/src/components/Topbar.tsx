import { useEffect, useRef, useState } from 'react';
import { Menu, Activity, Bell, LogOut, Search } from 'lucide-react';

import { api, subscribeBus } from '../api/client';
import { setPendingOpen } from '../api/openSessionChannel';

import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { EmptyState } from './ui/EmptyState';
import { Input } from './ui/Input';
/** F60: /api/health 前端消费——状态栏 30s 轮询展示会话/事件总量
 * (ok 掉线变红)。R32D44: 模型名字样已移除(供应商多态, 见设置页)。 */
interface HealthInfo { ok: boolean; sessions: number; bus: number; }

interface TreeSess { id: string; agentKey: string; title: string | null; rawTitle?: string | null; busy?: boolean; workSessionId?: string | null }
interface BusEvt { seq: number; ts?: string; type: string | null; title: string | null; summary: string | null; severity?: string | null; status?: string | null; revises?: number | null }

/** F69: 顶栏搜索此前是空壳(placeholder 承诺"会话/资产/发现/CVE"但无任何
 * 逻辑)。实现: ≥2 字符防抖搜索会话(/sessions/tree 轻投影)+总线条目
 * (intel/vulnerability/task-report 的 title/summary, CVE 正则匹配)。 */
const SEARCHABLE = new Set(['intel', 'intel-note', 'vulnerability', 'task-report']);

/** F70: 通知铃铛此前是纯装饰(硬编码红点+无逻辑)。实装:
 * - 漏洞发布(vulnerability)与新失败报告(task-report failed)推送为通知
 * - 铃铛角标=未读数; 下拉列表(最近 20); 点击通知跳对应页; 全部已读
 * - 数据面零新增: 复用 subscribeBus 全局单例(boot 快照取漏掉的) */
interface Notice { seq: number; kind: 'vulnerability' | 'report-failed'; text: string; hash: string; at: string }

const NOTICE_HASH: Record<Notice['kind'], string> = {
  vulnerability: 'audit',
  'report-failed': 'reports',
};

function noticeOf(e: BusEvt): Notice | null {
  // R19-F2: 修订事件(revises 指针, type 继承原始)不触发通知——同一
  // 漏洞多次修订此前多次响铃+未读虚增(活库 33 条修订匹配谓词);
  // void 撤回性修订按设计同样不响。通知身份=原始发布。
  if (e.revises) return null;
  if (e.type === 'vulnerability') {
    return { seq: e.seq, kind: 'vulnerability',
      text: `[${e.severity ?? '?'}] ${e.title ?? e.summary ?? ''}`,
      hash: NOTICE_HASH.vulnerability, at: e.ts ?? '' };
  }
  if (e.type === 'task-report' && e.status === 'failed') {
    return { seq: e.seq, kind: 'report-failed',
      text: `${e.title ?? e.summary ?? ''}`,
      hash: NOTICE_HASH['report-failed'], at: e.ts ?? '' };
  }
  return null;
}

export function Topbar({ onMenu }: { onMenu?: () => void }) {
  const [now, setNow] = useState(() => new Date());
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);  // FEUX5-P3: Cmd/Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [open, setOpen] = useState(false);
  const [sessHits, setSessHits] = useState<TreeSess[]>([]);
  const [sessTotal, setSessTotal] = useState(0);  // R32D31-N3: 截断计数提示
  const [busHits, setBusHits] = useState<BusEvt[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);

  // F70: 通知
  const [notices, setNotices] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const [bellOpen, setBellOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  /** 快照内最大 seq: SSE 单例 since=0 会重放全部历史——重放的旧事件
   *  合并进列表但不计未读, 只有快照之后的新事件才亮角标。 */
  const maxSeq = useRef(0);

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

  // F70: 快照先行、SSE 后接——订阅在快照落地后建立, since=0 的历史
  // 重放不再灌进未读计数(快照→订阅间隙的事件不亮角标, 数百 ms 窗口,
  // 面板页仍可见——可接受的权衡, 此前重放把 unread 顶到 99)。
  useEffect(() => {
    let stopped = false;
    let off = () => {};
    (async () => {
      try {
        const all = await api<BusEvt[]>('/bus');
        if (stopped) return;
        setNotices(all.map(noticeOf).filter((n): n is Notice => !!n).slice(-20).reverse());
        maxSeq.current = all.at(-1)?.seq ?? 0;
      } catch { /* 快照失败也订阅, SSE 兜底 */ }
      off = subscribeBus((name, raw) => {
        if (name !== 'bus') return;
        const e = raw as BusEvt;
        const n = noticeOf(e);
        if (!n) return;
        setNotices(prev => (prev.some(x => x.seq === n.seq) ? prev : [n, ...prev].slice(0, 20)));
        if (e.seq > maxSeq.current) {
          maxSeq.current = e.seq;
          setUnread(u => Math.min(u + 1, 99));
        }
      });
    })();
    return () => { stopped = true; off(); };
  }, []);

  // F69: 防抖搜索(会话树 + 总线条目)
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) { setSessHits([]); setBusHits([]); setOpen(false); return; }  // R32D30-E2: <2 字时复位下拉, 否则残留'无结果'提示自相矛盾
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const lower = query.toLowerCase();
        const cve = /cve-\d{4}-\d+/i.test(query);
        // R32D32-R6: q 下推服务端过滤, 不再每次击键全量拉树
        const [tree, bus] = await Promise.all([
          api<TreeSess[]>(`/sessions/tree?q=${encodeURIComponent(query)}`),
          api<BusEvt[]>(`/bus?q=${encodeURIComponent(query)}`),
        ]);
        if (cancelled) return;
        // R32D31-N3: 静默截断 5 条此前无提示(其余命中不可见不可达)
        // R32D32-R6: 服务端已按 q 过滤, 此处保留兜底匹配(兼容未带 q
        // 的旧后端/代理缓存)
        const allSess = tree.filter(s =>
          (s.rawTitle ?? s.title ?? '').toLowerCase().includes(lower)
          || s.id.includes(lower)
          || s.agentKey.toLowerCase().includes(lower),  // R32D35-E2: 匹配面对齐渲染面
        );
        setSessTotal(allSess.length);
        setSessHits(allSess.slice(0, 5));
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
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false);
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
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-chrome-line bg-chrome-surface px-4">
      <Button variant="ghostChrome" size="icon" className="md:hidden" onClick={onMenu} aria-label="打开导航">
        <Menu className="h-4 w-4" />
      </Button>
      {/* 全局搜索 (F69: 实装; §6.1-2 + §5.4/§5.8) */}
      <div ref={boxRef} className="relative w-80 max-md:w-40 max-sm:w-full">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-chrome-tertiary" />
        <Input
          value={q}
          onChange={e => setQ(e.target.value)}
          onFocus={() => { if (q.trim().length >= 2) setOpen(true); }}
          onKeyDown={e => { if (e.key === 'Escape') { setOpen(false); setQ(''); } }}
          placeholder="搜索会话 / 资产 / 发现 / CVE…"
          ref={searchRef}
          className="pl-8 pr-12 border-chrome-line bg-chrome-surface-2 text-chrome-primary placeholder:text-chrome-tertiary focus:border-chrome-accent-text"
        />
        <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-chrome-line bg-chrome-surface px-1.5 py-0.5 text-[11px] text-chrome-tertiary md:inline">⌘K</kbd>
        {open && sessHits.length === 0 && busHits.length === 0 && (
          <div className="absolute left-1/2 top-full z-40 mt-2 w-[26rem] -translate-x-1/2 rounded-lg border border-chrome-line bg-chrome-surface p-4 text-center text-[13px] text-chrome-tertiary shadow-lg">
            无结果——输入 ≥2 字搜索会话与总线条目
          </div>
        )}
        {open && (sessHits.length > 0 || busHits.length > 0) && (
          <div className="absolute left-0 top-full z-30 mt-1 w-[26rem] rounded-lg border border-chrome-line bg-chrome-surface p-1 shadow-lg">
            {sessHits.length > 0 && (
              <div className="px-2.5 py-1 text-xs font-medium text-chrome-tertiary">会话</div>
            )}
            {sessHits.length === 0 && busHits.length > 0 && (
              <p className="px-2.5 pb-1 pt-0.5 text-xs text-chrome-tertiary">无会话命中——以下为总线条目</p>
            )}
            {sessTotal > sessHits.length && (
              <p className="px-2.5 pb-1 text-xs text-chrome-tertiary">会话命中 {sessTotal} 条, 仅显示前 {sessHits.length}(换更精确关键词)</p>
            )}
            {sessHits.map(s => (
              <button key={s.id} onClick={() => {
                // R32D29-N2: 走 pendingOpen 通道——URL hash 双赋值方案
                // 里旧页消费 effect 会抢在路由提交前洗掉 ?s=(≈50% 丢)。
                const key = s.agentKey;  // CS3-N20: 恒等三元删除
                setOpen(false);
                // CS22-F1: 先 go 后 setPendingOpen——反向序时同步事件让已
                // 挂载的同路由页写好 ?s=, 随后 go() 整体替换 hash 又剥掉
                // (刷新恢复主控而非屏显会话)。
                go(key);
                setPendingOpen(key, s.id);
              }}
                className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-sm text-chrome-secondary hover:bg-chrome-surface-2 hover:text-chrome-primary">
                <span className="shrink-0 font-mono text-xs text-chrome-tertiary">{s.agentKey}</span>
                <span className="min-w-0 truncate">{s.title ?? s.id}</span>
              </button>
            ))}
            {busHits.length > 0 && (
              <div className="mt-1 px-2.5 py-1 text-xs font-medium text-chrome-tertiary">总线条目</div>
            )}
            {busHits.map(e => (
              <button key={e.seq} onClick={() => go(e.type === 'task-report' ? 'reports' : 'audit')}
                className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-sm text-chrome-secondary hover:bg-chrome-surface-2 hover:text-chrome-primary">
                <span className="shrink-0 font-mono text-xs text-chrome-tertiary">#{e.seq}</span>
                <span className="min-w-0 truncate">{e.title ?? e.summary ?? ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* F60: 时钟+运行状态(§6.1-2: sans 12px tertiary, · 分隔分组)。
          R32D44: 模型名字样移除——供应商已平台化(默认+单 agent 覆盖),
          单一模型名不再能代表全平台, 模型信息在设置页与各 agent 配置页签可见。 */}
      <div className="flex items-center gap-2 text-xs tabular-nums text-chrome-tertiary">
        <span className="hidden md:inline">{fmt(now)} 本地</span>
        <span aria-hidden="true">·</span>
        <div
          title={health
            ? `会话 ${health.sessions} · 总线事件 ${health.bus}`
            : 'runtime 不可达'}
          className="hidden items-center gap-1.5 md:flex"
        >
          <Activity className={health ? 'h-3.5 w-3.5 text-success-text' : 'h-3.5 w-3.5 text-danger-text'} />
          {health
            ? <span>{health.sessions} 会话 · {health.bus} 事件</span>
            : <span className="text-danger-text">runtime 不可达</span>}
        </div>
      </div>

      <div className="flex-1" />

      <Button
        variant="ghostChrome"
        size="icon"
        onClick={() => { window.location.href = '/spectre/logout'; }}
        title="登出"
      >
        <LogOut className="h-4 w-4" />
      </Button>

      {/* F70: 通知(实装) */}
      <div ref={bellRef} className="relative">
        <Button
          variant="ghostChrome"
          size="icon"
          onClick={() => { setBellOpen(v => !v); setUnread(0); }}
          title={unread > 0 ? `通知 · ${unread} 条未读` : '通知(漏洞/失败报告)'}
          className="relative"
        >
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-xs font-semibold text-white">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </Button>
        {bellOpen && (
          <div className="absolute right-0 top-full z-30 mt-1 w-80 rounded-lg border border-chrome-line bg-chrome-surface p-1 shadow-lg">
            {notices.length === 0 ? (
              <EmptyState tone="chrome" icon={Bell} title="暂无通知" hint="漏洞发布与失败报告将推送至此" />
            ) : notices.slice(0, 20).map(n => (
              <button key={n.seq} onClick={() => { setBellOpen(false); window.location.hash = n.hash; }}
                className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-chrome-surface-2">
                <Badge tone={n.kind === 'vulnerability' ? 'danger' : 'warning'} className="shrink-0 bg-transparent border border-danger-text/50 [&.border-warning-text]:border-warning-text/50">
                  {n.kind === 'vulnerability' ? '漏洞' : '失败'}
                </Badge>
                <span className="min-w-0 truncate text-sm text-chrome-secondary">{n.text}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}
