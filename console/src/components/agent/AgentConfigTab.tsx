/** AgentConfigTab — CS44-F17 拆出。 */
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { LlmFormatMeta } from '../../api/llmFormats';
import { AgentLlmOverride } from '../AgentLlmOverride';
import { Panel } from '../ui/Panel';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { Dot } from '../ui/Badge';
import { SpawnLimitSettings } from './SpawnLimitSettings';
import { RealSkillsPanel } from './RealSkillsPanel';
import { hasCred } from '../../utils/hasCred';
import { ShieldCheck } from 'lucide-react';

/** R32D44-feature: agent 配置页签——点开某 agent 后在此看它的完整配置面:
 * 生效运行配置(上下文窗口/模型/思考档位等, 来自全局通用配置)、挂载的
 * MCP、挂载的技能(点击直接展开正文)、专属数据源(apikey 配置态)。
 * 大模型区块带内联覆盖编辑器(与设置页同一保存协议/同一后端端点,
 * 单一数据源; 两个入口共享 AgentLlmOverride 组件, 不存在双写)。
 * 布局: 自适应宽度——面板 grid 随断点 1/2 列回流, 无固定像素宽; 技能
 * 正文 pre-wrap 满行折行。
 */
export function AgentConfigTab({ agentId, isAuto }: { agentId: string; isAuto: boolean }) {
  const [common, setCommon] = useState<Record<string, Record<string, string | number>> | null>(null);
  const [schemaAgents, setSchemaAgents] = useState<{ agentKey: string; label: string; hint: string;
    sources: { id: string; label: string; fields: { id: string; label: string }[] }[] }[]>([]);
  const [reconSources, setReconSources] = useState<Record<string, Record<string, string>>>({});
  const [agentLlm, setAgentLlm] = useState<Record<string, Record<string, string>>>({});
  const [llmFormats, setLlmFormats] = useState<LlmFormatMeta[]>([]);
  const [mcps, setMcps] = useState<{ name: string; transport: string; enabled?: boolean;
    url?: string; command?: string; agents?: string[] }[] | null>(null);

  const reloadLlm = () => api<{ common: Record<string, Record<string, string | number>> | null; agentLlm: Record<string, Record<string, string>> }>('/agent-settings')
    .then(d => { setCommon(d.common ?? {}); setAgentLlm(d.agentLlm ?? {}); })
    .catch(() => {});

  useEffect(() => {
    let cancelled = false;
    api<{ common: Record<string, Record<string, string | number>> | null;
      agentLlm: Record<string, Record<string, string>>;
      reconSources: Record<string, Record<string, string>>;
      schema: { agents: typeof schemaAgents; llmFormats?: LlmFormatMeta[] } }>('/agent-settings')
      .then(d => { if (!cancelled) { setCommon(d.common ?? {}); setAgentLlm(d.agentLlm ?? {}); setLlmFormats(d.schema?.llmFormats ?? []); setReconSources(d.reconSources ?? {}); setSchemaAgents(d.schema?.agents ?? []); } })
      .catch(() => { if (!cancelled) setCommon({}); });
    api<typeof mcps>('/sandbox/mcp')
      .then(list => { if (!cancelled) setMcps(list ?? []); })
      .catch(() => { if (!cancelled) setMcps([]); });
    return () => { cancelled = true; };
  }, []);

  // CS16-P2: 生效面板显示「默认之上合并覆盖后」的真实生效值——此前只
  // 合并了 format, baseUrl/model/key 仍显示默认值(覆盖后显示失真)。
  const baseLlm = (common?.llm ?? {}) as Record<string, string | number>;
  const ovLlm = agentLlm?.[agentId] ?? {};
  const llm: Record<string, string | number> = {
    ...baseLlm,
    format: ovLlm.format || baseLlm.format,
    baseUrl: ovLlm.baseUrl || baseLlm.baseUrl,
    apiKey: ovLlm.apiKey || baseLlm.apiKey,
    model: ovLlm.model || baseLlm.model,
  };
  const comp = (common?.compaction ?? {}) as Record<string, string | number>;
  // CS19-4: 格式中文名从 schema 单源取(与编辑器选项同源)
  const fmtLabel = llmFormats.find(f => f.id === String(llm.format || 'openai'))?.label ?? String(llm.format || 'openai');
  const mine = (mcps ?? []).filter(m => (m.agents ?? []).includes(agentId) && m.enabled !== false);
  const myGroup = schemaAgents.find(g => g.agentKey === agentId);
  const cfg = (v: string | number | undefined, d: string) => (v === undefined || v === '' ? d : String(v));

  return (
    <div className="grid w-full min-w-0 grid-cols-1 items-start gap-3 lg:grid-cols-2">
      {isAuto && <SpawnLimitSettings />}

      {/* 生效运行配置 + 本 agent 供应商覆盖(R32D44: 可直接改) */}
      <Panel title="大模型(生效配置 + 本 agent 覆盖)">
        <div className="space-y-2">
          <div className="space-y-1.5">
            {[
              ['格式', fmtLabel],
              ['Base URL', cfg(llm.baseUrl, '(未配置)')],
              ['模型', cfg(llm.model, '(未配置)')],
              ['Thinking Effort', cfg(llm.thinkingLevel, 'low')],
              ['最大输出 Tokens', cfg(llm.maxTokens, '32768')],
              ['上下文窗口 Tokens', cfg(llm.contextWindow, '786432')],
              ['上下文压缩', cfg(comp.enabled, '开启')],
              ['API Key', llm.apiKey ? '已配置' : '(未配置)'],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-2.5 py-1.5">
                <span className="shrink-0 text-xs text-tertiary">{k}</span>
                <span className="min-w-0 truncate font-mono text-[13px] text-secondary" title={v}>{v}</span>
              </div>
            ))}
          </div>
          <AgentLlmOverride agentId={agentId} formats={llmFormats} ov={agentLlm?.[agentId]} onSaved={reloadLlm} />
        </div>
      </Panel>

      {/* 挂载的 MCP */}
      <Panel title={`挂载的 MCP(${mine.length})`}>
        {mcps === null ? <div className="space-y-1.5"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /></div>
          : mine.length === 0 ? <EmptyState icon={ShieldCheck} title="该 agent 暂无挂载的 MCP 服务器" />
          : <div className="space-y-1.5">
            {mine.map(m => (
              <div key={m.name} className="rounded-md border border-line bg-surface px-2.5 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-[13px] text-secondary">{m.name}</span>
                  <Dot tone="cyan" />
                </div>
                <div className="mt-0.5 truncate font-mono text-xs text-tertiary" title={m.url ?? m.command}>
                  {m.transport === 'stdio' ? (Array.isArray(m.command) ? m.command.join(' ') : String(m.command ?? 'stdio')) : (m.url ?? m.transport ?? '')}
                </div>
              </div>
            ))}
            <a href="#mcp" className="block pt-1 text-xs text-accent-text underline-offset-2 hover:underline">
              在「MCP Server」页管理挂载 →
            </a>
          </div>}
      </Panel>

      {/* 挂载的技能(点击直接看正文) */}
      <Panel title="挂载的技能(点击查看内容)" className="min-w-0">
        <RealSkillsPanel agentKey={agentId} expandable />
      </Panel>

      {/* 专属数据源 / 参数(编辑在设置页) */}
      <Panel title="专属配置(数据源 / 参数)">
        {!myGroup ? <div className="text-[13px] text-tertiary">该 agent 无专属数据源配置组(仅用全局通用配置)。</div>
          : <div className="space-y-1.5">
            {myGroup.sources.map(src => {
              const vals = reconSources[src.id] ?? {};
              const has = hasCred(vals, src.id);  // R32D46-NEW-2: 第 7 处收敛
              return (
                <div key={src.id} className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-2.5 py-1.5">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] text-secondary">{src.label}</div>
                    <div className="truncate text-xs text-tertiary">{src.fields.map(f => f.label).join(' / ')}</div>
                  </div>
                  {has ? <span className="flex shrink-0 items-center gap-1 text-xs text-success-text"><ShieldCheck className="h-3 w-3" />已配置</span>
                    : <span className="shrink-0 text-xs text-tertiary">未配置</span>}
                </div>
              );
            })}
            <div className="pt-1 text-xs text-tertiary">{myGroup.hint}</div>
            <a href="#settings" className="block text-xs text-accent-text underline-offset-2 hover:underline">
              在「设置」页配置(保存前真实连通校验) →
            </a>
          </div>}
      </Panel>
    </div>
  );
}
