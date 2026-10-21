/**
 * ScopePanel — 目标资产档案面板(替代 TaskReportsPanel)。
 * 数据源: bus 事件 type='scope'(query_intel kind=scope 同源)。
 * 每条 = 一个资产(IP/域名): 端口/服务/版本/开源项目/OS/CDN/标签。
 */
import { useMemo } from 'react';
import { Globe, Server, Cpu, Shield } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { useBusPanelEntries } from '../../api/useBusPanelEntries';
import type { ApiBusEvent } from '../../api/client';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';

interface ScopePort {
  port: number;
  service: string | null;
  version: string | null;
  product: string | null;
}
interface ScopeProject {
  name: string | null;
  repo: string | null;
  version: string | null;
}
interface ScopeEntry {
  target: string;
  ports: ScopePort[];
  os: string | null;
  projects: ScopeProject[];
  cdn: string | null;
  ip: string | null;
  title: string | null;
  notes: string | null;
  tags: string[];
}

export function ScopePanel({ workSessionId, onOpen }: {
  workSessionId: string | null;
  onOpen?: (event: ApiBusEvent) => void;
}) {
  const { events: entries, loaded: loading } = useBusPanelEntries(
    (e) => e.type === 'scope', { ws: workSessionId ?? undefined });

  const scopes = useMemo(() => {
    // 同 target 取最新现行版(修订链折叠)
    const byTarget = new Map<string, { seq: number; data: ScopeEntry; revised: number; event: ApiBusEvent }>();
    for (const e of entries) {
      try {
        const data = JSON.parse(e.current?.detail ?? e.detail ?? '{}') as ScopeEntry;
        if (!data.target) continue;
        const prev = byTarget.get(data.target);
        const rev = e.revisedCount ?? 0;
        if (!prev || rev >= prev.revised) {
          byTarget.set(data.target, { seq: e.seq, data, revised: rev, event: e });
        }
      } catch { /* corrupt */ }
    }
    return [...byTarget.values()].sort((a, b) => a.data.target.localeCompare(b.data.target));
  }, [entries]);

  return (
    <div className="animate-enter flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-surface shadow-xs">
      <header className="flex items-center justify-between border-b border-line bg-surface-2/50 px-3 py-1.5">
        <h3 className="text-[13px] font-semibold text-secondary">
          资产档案
        </h3>
        <span className="text-xs tabular-nums text-tertiary">{scopes.length}</span>
      </header>
      <div className="flex-1 space-y-2 overflow-y-auto p-2" tabIndex={0} aria-label="资产档案列表">
        {scopes.length === 0 && (!loading
          ? <EmptyState icon={Globe} title="无资产档案" hint="recon 测绘后逐资产 publish_scope 落地" />
          : <Skeleton className="mx-1 my-2 h-11" />
        )}
      {scopes.map(({ data, revised, event }) => (
        <button
          key={data.target}
          onClick={() => onOpen?.(event)}
          className="group block w-full rounded-md border border-line-strong bg-surface p-3 text-left
            transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {/* 头行: target + CDN badge + 修订 */}
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold text-primary">
              {data.target}
            </span>
            {data.cdn && (
              <Badge tone="info" className="text-[10px]">
                <Shield className="mr-0.5 h-3 w-3" />{data.cdn}
              </Badge>
            )}
            {revised > 0 && (
              <span className="text-[10px] text-faint">⟳{revised}</span>
            )}
          </div>

          {/* OS */}
          {data.os && (
            <div className="mt-1.5 flex items-center gap-1.5 text-xs text-secondary">
              <Cpu className="h-3 w-3 text-faint" />
              <span>{data.os}</span>
            </div>
          )}

          {/* 端口/服务 */}
          {data.ports?.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
              {data.ports.slice(0, 8).map((p, i) => (
                <span key={i} className="font-mono text-secondary">
                  <span className="text-accent-text">{p.port}</span>
                  {p.service && <span className="text-tertiary">/{p.service}</span>}
                  {p.version && <span className="text-faint"> {p.version}</span>}
                </span>
              ))}
              {data.ports.length > 8 && (
                <span className="text-faint">+{data.ports.length - 8}</span>
              )}
            </div>
          )}

          {/* 开源项目 */}
          {data.projects?.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {data.projects.slice(0, 4).map((p, i) => (
                <Badge key={i} tone="accent" className="gap-0.5 text-[10px]">
                  <Server className="h-3 w-3" />
                  {p.name ?? p.repo}
                  {p.version && <span className="text-faint">@{p.version}</span>}
                </Badge>
              ))}
            </div>
          )}

          {/* 标签 */}
          {data.tags?.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {data.tags.slice(0, 6).map((t, i) => (
                <span key={i} className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] text-tertiary">
                  {t}
                </span>
              ))}
            </div>
          )}
        </button>
      ))}
      </div>
    </div>
  );
}
