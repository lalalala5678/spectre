/** AgentConfigTab — CS44-F17 拆出。 */
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { cn } from '../../utils/cn';
import type { LlmFormatMeta } from '../../api/llmFormats';
import { AgentLlmOverride } from '../AgentLlmOverride';
import { Panel } from '../ui/Panel';
import { Input, Select } from '../ui/Input';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { Dot } from '../ui/Badge';
import { SpawnLimitSettings } from './SpawnLimitSettings';
import { RealSkillsPanel } from './RealSkillsPanel';
import { hasCred } from '../../utils/hasCred';
import { ShieldCheck, Eye, EyeOff } from 'lucide-react';

/** R32D44-feature: agent 配置页签——点开某 agent 后在此看它的完整配置面:
 * 生效运行配置(上下文窗口/模型/思考档位等, 来自全局通用配置)、挂载的
 * MCP、挂载的技能(点击直接展开正文)、专属数据源(apikey 配置态)。
 * 大模型区块带内联覆盖编辑器(与设置页同一保存协议/同一后端端点,
 * 单一数据源; 两个入口共享 AgentLlmOverride 组件, 不存在双写)。
 * 布局: 自适应宽度——面板 grid 随断点 1/2 列回流, 无固定像素宽; 技能
 * 正文 pre-wrap 满行折行。
 */
/** 用户令: 配置分组总览(与平台设置页同形态的左侧一级菜单) */
/* 用户令自查: 内容小块不拆一级菜单——派生限额+大模型合'运行配置',
 * MCP+技能合'挂载', 专属配置独立 */
const CFG_SECTIONS = [
  { id: 'cfg-run', label: '运行配置' },
  { id: 'cfg-mounts', label: '挂载' },
  { id: 'cfg-own', label: '专属配置' },
];

export function AgentConfigTab({ agentId, isAuto }: { agentId: string; isAuto: boolean }) {
  const [activeSec, setActiveSec] = useState(CFG_SECTIONS[0].id);
  // scroll-spy: 可视比例最大的分组即高亮(IntersectionObserver 轻量)
  useEffect(() => {
    const els = CFG_SECTIONS
      .map(x => document.getElementById(x.id))
      .filter(Boolean) as HTMLElement[];
    if (!els.length) return;
    const io = new IntersectionObserver(entries => {
      const best = entries.filter(e => e.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (best) setActiveSec(best.target.id);
    }, { threshold: [0.15, 0.4, 0.75] });
    els.forEach(el => io.observe(el));
    return () => io.disconnect();
  }, [isAuto]);
  const [common, setCommon] = useState<Record<string, Record<string, string | number>> | null>(null);
  const [schemaAgents, setSchemaAgents] = useState<{ agentKey: string; label: string; hint: string;
    sources: { id: string; label: string; fields: { id: string; label: string }[] }[] }[]>([]);
  const [reconSources, setReconSources] = useState<Record<string, Record<string, string>>>({});
  const [agentLlm, setAgentLlm] = useState<Record<string, Record<string, string>>>({});
  const [llmFormats, setLlmFormats] = useState<LlmFormatMeta[]>([]);
  const [mcps, setMcps] = useState<{ name: string; transport: string; enabled?: boolean;
    url?: string; command?: string; agents?: string[] }[] | null>(null);

  const reloadSources = () => api('/agent-settings')
    .then(d => { setReconSources((d as { reconSources: Record<string, Record<string, string>> }).reconSources ?? {}); })
    .catch(() => {});
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
    /* 用户令: 配置项单列+左侧总览一级菜单(与平台设置页同形态) */
    <div className="flex w-full min-w-0 gap-4">
      <nav aria-label="配置分组" className="hidden w-40 shrink-0 flex-col gap-0.5 self-sticky top-0 py-1 md:flex">
        {CFG_SECTIONS.map(sec => (
          <button key={sec.id}
            onClick={() => document.getElementById(sec.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            className={cn('rounded-md px-2.5 py-2 text-left text-[13px] transition-colors',
              activeSec === sec.id ? 'bg-accent-subtle font-medium text-accent-text' : 'text-secondary hover:bg-surface-2 hover:text-primary')}>
            {sec.label}
          </button>
        ))}
      </nav>
      <div className="mx-auto flex min-w-0 max-w-4xl flex-1 flex-col gap-4">  {/* 用户令: 统一宽+按菜单三组 */}
        {/* 运行配置: 派生限额(仅 autopwn)+大模型 */}
        <section id="cfg-run" className="flex scroll-mt-2 flex-col gap-3">
          {isAuto && <div className="[&>div]:shadow-xs"><SpawnLimitSettings /></div>}
          <Panel title="大模型" className="shadow-xs">
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
              <AgentLlmOverride agentId={agentId} formats={llmFormats} ov={agentLlm?.[agentId]} onSaved={reloadLlm}
                onDirtyChange={d => window.dispatchEvent(new CustomEvent('spectre:dirty-set',
                  { detail: { src: `agentConfig:${agentId}`, count: d ? 1 : 0 } }))} />
            </div>
          </Panel>
        </section>

        {/* 挂载: MCP+技能(只读, 用户裁定不可增配) */}
        <section id="cfg-mounts" className="flex scroll-mt-2 flex-col gap-3">
          <Panel title={`挂载的 MCP(${mine.length})`} className="shadow-xs">
            {mcps === null ? <div className="space-y-1.5"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /></div>
              : mine.length === 0 ? <EmptyState icon={ShieldCheck} title="该 agent 暂无挂载的 MCP 服务器" />
              : <div className="space-y-1.5">
                {mine.map(m => (
                  <div key={m.name} className="rounded-md border border-line bg-surface px-2.5 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-mono text-[13px] text-secondary">{m.name}</span>
                      <Dot tone="info" />
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
          <Panel title="挂载技能" className="min-w-0 shadow-xs">
            <RealSkillsPanel agentKey={agentId} expandable />
          </Panel>
        </section>

        {/* 专属配置: 数据源/参数(直接编辑, 与设置页同一保存协议) */}
        <section id="cfg-own" className="scroll-mt-2">
          <Panel title="专属配置" className="shadow-xs">
            {!myGroup ? <div className="text-[13px] text-tertiary">该智能体没有专属配置, 使用全局通用配置即可。</div>
              : <div className="space-y-3">
                {myGroup.sources.map(src => (
                  <SourceInlineEditor key={src.id} src={src} cfg={reconSources[src.id] ?? {}}
                    onSaved={reloadSources} agentKey={agentId} />
                ))}
              </div>}
          </Panel>
        </section>
      </div>
    </div>
  );
}



/** EQ-2: agent 配置页签内的数据源内联编辑器(逐字段保存+密码眼睛,
 * 与设置页同协议; 独立小组件避免整页状态机复制)。 */
function SourceInlineEditor({ src, cfg, onSaved, agentKey }: {
  src: { id: string; label: string; fields: { id: string; label: string; type?: string; options?: string[] }[] };
  cfg: Record<string, string>;
  onSaved: () => void;
  agentKey: string;
}) {
  const group = agentKey === 'weakcred' ? 'weakcred' : 'recon-source';
  const save = (fullId: string) => async (v: string) => {
    await api('/agent-settings/save', { method: 'POST', json: { group, field: fullId, value: v } });
    onSaved();
  };
  return (
    <div className="rounded-md border border-line bg-surface p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-secondary">{src.label}</span>
        {hasCred(cfg, src.id)
          ? <span className="flex shrink-0 items-center gap-1 text-xs text-success-text"><ShieldCheck className="h-3 w-3" />已配置</span>
          : <span className="shrink-0 text-xs text-tertiary">未配置</span>}
      </div>
      <div className="space-y-1.5">
        {src.fields.map(f => {
          // FEVERIFY11-P1-2: schema f.id 已是全限定(zoomeye.key)——此前
          // 再拼 src.id 成三段必 400; 存量值按 leaf 键取(此前查全 id 永空)。
          const leaf = f.id.split('.').pop() as string;
          return (
            <InlineField key={f.id} id={f.id} label={f.label} type={f.type} options={f.options}
              value={cfg[leaf]} onSave={save(f.id)} revealKind="source" revealId={src.id}
              onDirtyChange={d => window.dispatchEvent(new CustomEvent('spectre:dirty-set',
                { detail: { src: `agentConfig:${agentKey}:src`, count: d ? 1 : 0 } }))} />
          );
        })}
      </div>
    </div>
  );
}

/** 单字段行(保存前探测由后端统一做; password 带眼睛)。 */
function InlineField({ id, label, type, options, value, onSave, revealKind, revealId, onDirtyChange }: {
  id: string; label: string; type?: string; options?: string[]; value?: string;
  onSave: (v: string) => Promise<void>; revealKind: 'source'; revealId: string;
  onDirtyChange?: (d: boolean) => void;  // EQ-2: 脏离开接入
}) {
  const [draft, setDraft] = useState(String(value ?? ''));
  const [state, setState] = useState<'idle' | 'saving' | 'ok' | 'err'>('idle');
  const [msg, setMsg] = useState('');
  const [peek, setPeek] = useState(false);
  const [peekVal, setPeekVal] = useState('');
  const dirty = draft !== String(value ?? '');
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onDirtyChange?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    if (!dirty) return;
    setState('saving'); setMsg('');
    try { await onSave(draft); setState('ok'); setTimeout(() => setState('idle'), 1800); }
    catch (e) { setState('err'); setMsg(e instanceof Error ? e.message : String(e)); }
  }
  const togglePeek = async () => {
    if (peek) { setPeek(false); return; }
    try {
      const r = await api<{ value: string }>('/agent-settings/reveal', {
        method: 'POST', json: { kind: revealKind, id: revealId, field: id.split('.').pop() ?? id } });
      setPeekVal(r.value || '(空)'); setPeek(true);
    } catch { setPeekVal('(查看失败)'); setPeek(true); }
  }
  return (
    <div className="flex items-center gap-2">
      <span className="w-[86px] shrink-0 text-[13px] text-secondary">{label}</span>
      <div className="relative min-w-0 flex-1">
        {type === 'select' ? (  // FEVERIFY11-P2-3: 枚举字段用下拉(与设置页一致)
          <Select value={draft} onChange={e => { setDraft(e.target.value); setState('idle'); }}
            className={cn('w-full', state === 'err' ? 'border-danger-line' : dirty && 'border-accent')}>
            {(options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
          </Select>
        ) : (
        <Input type={type === 'password' && !peek ? 'password' : 'text'} value={type === 'password' && peek ? peekVal : draft}
          readOnly={type === 'password' && peek}
          onChange={e => { setDraft(e.target.value); setState('idle'); }}
          onKeyDown={e => { if (e.key === 'Enter') void save(); }}
          className={cn('w-full font-mono text-[13px]',
            state === 'err' ? 'border-danger-line' : dirty && 'border-accent')} />
        )}
        {type === 'password' && (
          <button type="button" onClick={() => void togglePeek()} aria-label={peek ? '隐藏明文' : '查看明文'}
            title={peek ? '隐藏明文' : '查看明文(操作会留审计日志)'}
            className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-tertiary hover:bg-surface-2 hover:text-primary">
            {peek ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
      <Button onClick={() => void save()} disabled={!dirty || state === 'saving'} variant="primary" size="sm" className="min-w-20 shrink-0">
        {state === 'saving' ? '检测中' : state === 'ok' ? '✓ 已保存' : '保存'}
      </Button>
      {state === 'err' && <span className="max-w-56 shrink-0 truncate text-xs text-danger-text" title={msg}>{msg}</span>}
    </div>
  );
}
