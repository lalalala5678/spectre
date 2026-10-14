/**
 * ScopePanel — 目标资产档案面板(替代 TaskReportsPanel)。
 * 数据源: bus 事件 type='scope'(query_intel kind=scope 同源)。
 * 每条 = 一个资产(IP/域名): 端口/服务/版本/开源项目/OS/CDN/标签。
 */
import { useMemo } from 'react';
import { Globe, Server, Cpu, Shield, Tag } from 'lucide-react';
import { useBusPanelEntries } from '../../api/useBusPanelEntries';
import { Badge, Dot } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { cn } from '../../utils/cn';

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

export function ScopePanel({ agentKey, workSessionId, onOpen }: {
  agentKey: string;
  workSessionId: string | null;
  onOpen?: (seq: number) => void;
}) {
  const { entries, loading } = useBusPanelEntries({
    agentKey, workSessionId, accept: (e) => e.type === 'scope',
  });

  const scopes = useMemo(() => {
    // 同 target 取最新现行版(修订链折叠)
    const byTarget = new Map<string, { seq: number; data: ScopeEntry; revised: number }>();
    for (const e of entries) {
      try {
        const data = JSON.parse(e.detail ?? '{}') as ScopeEntry;
        if (!data.target) continue;
        const prev = byTarget.get(data.target);
        const rev = e.revisedCount ?? 0;
        if (!prev || rev >= prev.revised) {
          byTarget.set(data.target, { seq: e.seq, data, revised: rev });
        }
      } catch { /* corrupt */ }
    }
    return [...byTarget.values()].sort((a, b) => a.data.target.localeCompare(b.data.target));
  }, [entries]);

  if (loading && scopes.length === 0) {
    return <Skeleton className="h-32 w-full rounded-lg" />;
  }
  if (scopes.length === 0) {
    return (
      <EmptyState
        icon={<Globe className="h-6 w-6 text-faint" />}
        title="无资产档案"
        subtitle="recon 测绘后逐资产 publish_scope 落地"
      />
    );
  }

  return (
    <div className="space-y-2 overflow-y-auto">
      <div className="px-1 pb-1 text-[11px] font-medium tracking-wide text-tertiary">
        资产档案 · {scopes.length} 条
      </div>
      {scopes.map(({ seq, data, revised }) => (
        <button
          key={data.target}
          onClick={() => onOpen?.(seq)}
          className="group block w-full rounded-lg border border-line bg-surface p-3 text-left
            transition-colors hover:border-line-strong hover:bg-surface-2"
        >
          {/* 头行: target + CDN badge + 修订 */}
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold text-primary">
              {data.target}
            </span>
            {data.cdn && (
              <Badge variant="outline" className="text-[10px]">
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
                <Badge key={i} variant="default" className="gap-0.5 text-[10px]">
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
  );
}
