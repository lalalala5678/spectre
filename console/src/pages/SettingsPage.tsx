import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Loader2, Check, AlertTriangle, RotateCw, Radar, Sparkles, ShieldCheck } from 'lucide-react';
import { cn } from '../utils/cn';
import { AgentLlmOverride } from '../components/AgentLlmOverride';

/**
 * Agent 设置栏 — 通用配置(全局)+ Agent 特有配置(本轮:资产测绘数据源)。
 *
 * 交互铁律(用户设计):大多数字段独立保存按钮(改动高亮→转圈→探测/范围
 * 校验→失败红字不落盘/成功绿勾);LLM 供应商两类(默认+单 agent 覆盖)为
 * 四字段原子编辑器(一请求整体探测)。枚举用下拉,文本/数值用输入框。
 */

interface FieldDef {
  id: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'select';
  options?: string[];
  hint?: string;
  placeholder?: string;
  default?: string | number;
}
interface SourceDef {
  id: string; label: string; defaultBase: string; tier?: string; why?: string; fields: FieldDef[];
}
interface SettingsPayload {
  common: Record<string, Record<string, string | number>> | null;
  agentLlm: Record<string, Record<string, string>>;
  reconSources: Record<string, Record<string, string>>;
  schema: {
    llmFormats?: { id: string; label: string; hint: string }[];
    common: { label: string; fields: FieldDef[] };
    agents: { agentKey: string; label: string; hint?: string; sources: SourceDef[] }[];
    agentLlm: { agentKey: string; label: string; hint?: string; fields: FieldDef[] }[];
  };
}

/** CS17-4: 后端 hasSourceCredential 的前端镜像(单源在
 * backend/src/agent-settings.mjs——改谓词两侧同步)。 */
const hasCred = (cfg: Record<string, string> | undefined, sid: string) =>
  Boolean(cfg && (cfg.key || cfg.token || cfg.secret || cfg.password
    || (sid === 'smtp' && cfg.user)));

const TIER_STYLE: Record<string, { label: string; chip: string; dot: string; groupLabel: string }> = {
  P0: { label: 'P0', chip: 'border-orange-600/60 bg-orange-950/50 text-orange-300', dot: 'bg-orange-400', groupLabel: '必配 · 两大结构性缺口' },
  P1: { label: 'P1', chip: 'border-amber-700/50 bg-amber-950/40 text-amber-300', dot: 'bg-amber-400', groupLabel: '建议 · 免费层够用' },
  P2: { label: 'P2', chip: 'border-zinc-600/60 bg-zinc-800/60 text-zinc-400', dot: 'bg-zinc-500', groupLabel: '增益 · 多源并集提覆盖' },
};

/** 单字段行:label + input/select + 保存按钮(未保存高亮/转圈/成功/失败态) */
function FieldRow({ def, value, onSave }: {
  def: FieldDef;
  value: string | number | undefined;
  onSave: (v: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(value ?? def.default ?? ''));
  const [orig, setOrig] = useState(String(value ?? def.default ?? ''));
  const [state, setState] = useState<'idle' | 'saving' | 'ok' | 'err'>('idle');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    const v = String(value ?? def.default ?? '');
    setDraft(v); setOrig(v); setState('idle'); setMsg('');
  }, [value, def.default]);

  const dirty = draft !== orig;

  async function save() {
    if (!dirty || state === 'saving') return;
    setState('saving'); setMsg('');
    try {
      await onSave(draft);
      setOrig(draft); setState('ok');
      setTimeout(() => setState('idle'), 1800);
    } catch (e) {
      setState('err'); setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="group grid grid-cols-[minmax(150px,230px)_1fr_auto] items-center gap-3 py-2.5 transition-colors hover:bg-void-800/30">
      <div className="min-w-0 pl-1">
        <div className="text-[12.5px] text-zinc-300">{def.label}</div>
        {def.hint && <div className="mt-0.5 text-[10.5px] leading-tight text-zinc-600">{def.hint}</div>}
      </div>
      <div className="min-w-0">
        {def.type === 'select' ? (
          <select
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full max-w-md cursor-pointer rounded-sm border border-void-600 bg-void-950 px-2.5 py-1.5 font-mono text-[12.5px] text-zinc-200 outline-none transition-colors hover:border-void-500 focus:border-orange-700"
          >
            {(def.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <input
            type={def.type === 'password' ? 'password' : def.type === 'number' ? 'number' : 'text'}
            value={draft}
            placeholder={def.placeholder}
            onChange={(e) => { setDraft(e.target.value); if (state !== 'saving') setState('idle'); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
            className={cn('w-full max-w-md rounded-sm border bg-void-950 px-2.5 py-1.5 font-mono text-[12.5px] text-zinc-200 outline-none transition-colors',
              state === 'err' ? 'border-red-800' : dirty ? 'border-orange-700' : 'border-void-600 hover:border-void-500 focus:border-orange-700')}
          />
        )}
        {state === 'err' && (
          <div className="mt-1.5 flex items-start gap-1.5 rounded-sm border border-red-900/50 bg-red-950/30 px-2 py-1 text-[11px] leading-snug text-red-300">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{msg || '校验失败'}
          </div>
        )}
      </div>
      <button
        onClick={() => void save()}
        disabled={!dirty || state === 'saving'}
        className={cn('flex w-[76px] items-center justify-center gap-1.5 rounded-sm border px-3 py-1.5 font-mono text-[11.5px] transition-all',
          state === 'ok' ? 'border-emerald-700 bg-emerald-950/40 text-emerald-400'
            : state === 'saving' ? 'border-void-600 bg-void-800 text-zinc-300'
            : dirty ? 'border-orange-600 bg-orange-950/40 text-orange-300 hover:bg-orange-900/50 active:scale-95'
            : 'border-void-800 text-zinc-700')}
      >
        {state === 'saving'
          ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />检测中</>
          : state === 'ok'
            ? <><Check className="h-3.5 w-3.5" />已保存</>
            : '保存'}
      </button>
    </div>
  );
}

/** 数据源卡片(带 tier 徽章 + 挂载状态) */
function SourceCard({ src, cfg, onSave, verify }: {
  src: SourceDef;
  cfg: Record<string, string> | undefined;
  onSave: (leaf: string) => (v: string) => Promise<void>;
  verify?: { ok: boolean; error?: string | null };
}) {
  const [open, setOpen] = useState(true);
  const isParams = src.id === 'brute';
  const paramCount = Object.values(cfg ?? {}).filter(v => String(v ?? '').length > 0).length;
  // CS17-4: 谓词镜像后端 hasSourceCredential 单源(key/token/secret/
  // password + 组特例 smtp.user; id 是参数型字段不算)。
  const mounted = isParams ? paramCount > 0 : hasCred(cfg, src.id);
  const tier = TIER_STYLE[src.tier ?? 'P2'];
  const verifyState = verify;
  return (
    <div className={cn('overflow-hidden rounded border transition-colors',
      mounted ? 'border-emerald-900/60 bg-void-900/40' : 'border-void-700 bg-void-900/20')}>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-void-800/40"
      >
        <span className={cn('h-2 w-2 shrink-0 rounded-full', mounted ? 'bg-emerald-400 shadow-[0_0_6px] shadow-emerald-500/60' : tier.dot)} />
        <span className="text-[13px] font-medium text-zinc-200">{src.label}</span>
        <span className={cn('ml-auto shrink-0 rounded-sm px-2 py-0.5 font-mono text-[10px]',
          verifyState && !verifyState.ok ? 'bg-red-950/60 text-red-400'
            : mounted ? 'bg-emerald-950/60 text-emerald-400' : 'bg-void-800 text-zinc-500')}>
          {verifyState && !verifyState.ok
            ? 'key 已失效 · 不注入'
            : isParams ? `参数组 · ${paramCount} 项已注入`
            : mounted ? (verifyState ? '已验证 · 已注入' : '已挂载 MCP') : '未配置 · 不注入'}
        </span>
        {verifyState && !verifyState.ok && verifyState.error && (
          <span className="max-w-[220px] truncate font-mono text-[9.5px] text-red-400/70" title={verifyState.error}>{verifyState.error}</span>
        )}
        <svg className={cn('h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform', open && 'rotate-90')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>
      {open && (
        <div className="divide-y divide-void-800 border-t border-void-800/70">
          {src.fields.map((f) => (
            <FieldRow
              key={f.id}
              def={{ ...f, placeholder: f.placeholder ?? (f.id.endsWith('baseUrl') ? `默认 ${src.defaultBase}` : undefined) }}
              value={cfg?.[f.id.split('.')[1]]}
              onSave={onSave(f.id.split('.')[1])}
            />
          ))}
        </div>
      )}
    </div>
  );
}
export function SettingsPage() {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [err, setErr] = useState('');
  const [verify, setVerify] = useState<Record<string, { ok: boolean; error?: string | null }> | null>(null);
  const [verifying, setVerifying] = useState(false);
  const runVerify = () => {
    setVerifying(true);
    api<{ results: { id: string; ok?: boolean; error?: string | null }[] }>('/agent-settings/verify')
      .then((r) => {
        const m: Record<string, { ok: boolean; error?: string | null }> = {};
        for (const it of r.results) if (it.ok !== undefined) m[it.id] = { ok: it.ok, error: it.error };
        setVerify(m);
      })
      .catch(() => setVerify(null))
      .finally(() => setVerifying(false));
  };

  const reload = () => api<SettingsPayload>('/agent-settings')
    .then(setData)
    .catch((e) => setErr(e instanceof Error ? e.message : String(e)));

  useEffect(() => { void reload(); }, []);

  const saveCommon = (fieldId: string) => async (v: string) => {
    await api('/agent-settings/save', { method: 'POST', json: { group: 'common', field: fieldId, value: v } });
    await reload();
  };
  const saveSource = (srcId: string, group = 'recon-source') => (leaf: string) => async (v: string) => {
    await api('/agent-settings/save', { method: 'POST', json: { group, field: `${srcId}.${leaf}`, value: v } });
    await reload();
  };

  if (err) return <div className="p-6 text-red-400">设置加载失败:{err}</div>;
  if (!data) return <div className="animate-pulse p-6 text-zinc-500">加载中…</div>;

  const cs = data.common ?? {};
  const llm = (cs.llm ?? {}) as Record<string, string>;
  const comp = (cs.compaction ?? {}) as Record<string, string>;
  const ws = (cs.webSearch ?? {}) as Record<string, string>;
  const groups = data.schema.agents ?? [];
  const reconAgent = groups.find((a) => a.agentKey === 'recon');
  const otherAgents = groups.filter((a) => a.agentKey !== 'recon');
  const sources = reconAgent?.sources ?? [];
  const mountedCount = sources.filter((s) => hasCred(data.reconSources[s.id], s.id)).length;
  const byTier = (t: string) => sources.filter((s) => (s.tier ?? 'P2') === t);
  const groupOf = (agentKey: string) => (agentKey === 'weakcred' ? 'weakcred' : 'recon-source');

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      {/* 标题 + 概览 */}
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-[16px] font-medium text-zinc-100">
            <Sparkles className="h-4 w-4 text-orange-400" />Agent 配置
          </h1>
          <p className="mt-1 text-[11.5px] text-zinc-500">
            每条配置独立保存:点击保存后先用所填值做真实连通检测/范围校验,失败不落盘。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void runVerify()} disabled={verifying}
            className="mb-1 flex items-center gap-1.5 rounded-sm border border-void-600 px-2.5 py-1 font-mono text-[11px] text-zinc-300 transition-colors hover:border-orange-700 hover:text-orange-300 disabled:opacity-50">
            {verifying ? <><Loader2 className="h-3 w-3 animate-spin" />复查中</> : <><ShieldCheck className="h-3 w-3" />复查可用性</>}
          </button>
          <button onClick={() => void reload()} title="刷新"
            className="mb-1 text-zinc-600 transition-colors hover:text-zinc-300"><RotateCw className="h-3.5 w-3.5" /></button>
        </div>
      </div>

      {/* ---------- 通用配置(全局) ---------- */}
      <section className="mb-8 overflow-hidden rounded border border-void-700 bg-void-900/30">
        <div className="flex items-center gap-2 border-b border-void-700 bg-gradient-to-r from-void-800/60 to-transparent px-4 py-3">
          <ShieldCheck className="h-3.5 w-3.5 text-zinc-400" />
          <span className="text-[12.5px] font-medium text-zinc-200">{data.schema.common.label}</span>
        </div>
        <div className="divide-y divide-void-800/70">
          {/* R32D45-N1: llm 四字段(格式/URL/Key/模型)走原子编辑器——
              逐字段保存×合并探测有跨厂商中间态死锁(换供应商先存 URL
              的瞬间=新 URL+旧 key→401 存不进)。 */}
          <div className="px-4 py-2.5">
            <AgentLlmOverride agentId="" mode="default" formats={data.schema.llmFormats} ov={{
              format: String(llm.format ?? ''), baseUrl: String(llm.baseUrl ?? ''),
              apiKey: String(llm.apiKey ?? ''), model: String(llm.model ?? ''),
            }} onSaved={() => void reload()} />
          </div>
          {data.schema.common.fields.filter(f => !['llm.format', 'llm.baseUrl', 'llm.apiKey', 'llm.model'].includes(f.id)).map((f) => {
            const [top, leaf] = f.id.split('.');
            // CS16-P2: webSearch 三字段此前落空 bucket(只认 llm/comp)——
            // 保存后回显恒空, 用户以为没存上。
            const bucket = top === 'llm' ? llm : (top === 'webSearch' ? ws : comp);
            return <FieldRow key={f.id} def={f} value={bucket[leaf]} onSave={saveCommon(f.id)} />;
          })}
        </div>
      </section>

      {/* ---------- R32D44: 单 Agent 大模型供应商覆盖 ---------- */}
      <section className="mb-8 overflow-hidden rounded border border-void-700 bg-void-900/30">
        <div className="flex items-center gap-2 border-b border-void-700 bg-gradient-to-r from-void-800/60 to-transparent px-4 py-3">
          <span className="text-[12.5px] font-medium text-zinc-200">单 Agent 大模型覆盖</span>
          <span className="text-[10.5px] text-zinc-500">默认供应商之上按 agent 换厂商/模型(例: 默认 GLM, 报告 agent 用 DeepSeek)</span>
        </div>
        <p className="border-b border-void-800/70 px-4 py-2 text-[11px] leading-relaxed text-zinc-500">
          四字段全留空=完全继承默认;填任一项并保存会用「覆盖后的生效配置」做真实连通探测, 通过才落盘。清除某项=保存空值。
        </p>
        <div className="divide-y divide-void-800/70">
          {(data.schema.agentLlm ?? []).map((g) => {
            const ov = data.agentLlm?.[g.agentKey] ?? {};
            const overridden = Boolean(ov.baseUrl || ov.apiKey || ov.model || ov.format);
            return (
              <div key={g.agentKey} className="px-4 py-2.5">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-[11.5px] font-medium text-zinc-300">{g.label}</span>
                  {overridden
                    ? <span className="rounded-sm bg-orange-950/60 px-1.5 py-0.5 font-mono text-[9.5px] text-orange-300">已覆盖</span>
                    : <span className="rounded-sm bg-void-800 px-1.5 py-0.5 font-mono text-[9.5px] text-zinc-600">用默认</span>}
                </div>
                {/* CS16-P1: 原子四字段编辑器(与 agent 配置页签同款共享组件)——
                    逐字段保存×整体探测有跨供应商中间态死锁 */}
                <AgentLlmOverride agentId={g.agentKey} formats={data.schema.llmFormats} ov={ov} onSaved={() => void reload()} />
              </div>
            );
          })}
        </div>
      </section>

      {/* ---------- 其它 Agent 参数/数据源组(爆破参数·NDay 等) ---------- */}
      {otherAgents.map((agent) => (
        <section key={agent.agentKey} className="mb-8 overflow-hidden rounded border border-void-700 bg-void-900/30">
          <div className="flex items-center gap-2 border-b border-void-700 bg-gradient-to-r from-void-800/60 to-transparent px-4 py-3">
            <span className="text-[12.5px] font-medium text-zinc-200">{agent.label}</span>
          </div>
          {agent.hint && <p className="border-b border-void-800/70 px-4 py-2 text-[11px] leading-relaxed text-zinc-500">{agent.hint}</p>}
          {agent.sources.length === 0 ? (
            <div className="px-4 py-3 text-[11.5px] text-zinc-500">该智能体无独立数据源配置。</div>
          ) : (
            <div className="divide-y divide-void-800/70">
              {agent.sources.map((src) => (
                <SourceCard key={src.id} src={src} cfg={data.reconSources[src.id]} verify={verify?.[src.id]} onSave={saveSource(src.id, groupOf(agent.agentKey))} />
              ))}
            </div>
          )}
        </section>
      ))}


      {/* ---------- 资产测绘数据源(按重要性分级) ---------- */}
      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Radar className="h-4 w-4 text-orange-400" />
            <span className="text-[13.5px] font-medium text-zinc-100">资产测绘 Agent · 数据源</span>
            <span className="text-[11px] text-zinc-500">按重要性排序</span>
          </div>
          <div className="flex items-center gap-2 font-mono text-[11px]">
            <span className="text-zinc-500">已启用</span>
            <span className={cn('rounded-sm px-2 py-0.5', mountedCount ? 'bg-emerald-950/60 text-emerald-400' : 'bg-void-800 text-zinc-500')}>
              {mountedCount}/{sources.length}
            </span>
            <span className={cn('rounded-sm px-2 py-0.5', mountedCount ? 'bg-orange-950/60 text-orange-300' : 'bg-void-800 text-zinc-600')}>
              MCP {mountedCount ? '已挂载' : '未挂载'}
            </span>
          </div>
        </div>
        <p className="mb-4 text-[11px] leading-relaxed text-zinc-500">
          填好并通过连通验证的源才会挂载为 MCP 工具;未配置的源对 agent 完全不可见(零污染)。Base URL 留空一律使用官方地址。
        </p>

        {(['P0', 'P1', 'P2'] as const).map((t) => (
          <div key={t} className="mb-4">
            <div className="mb-2 flex items-center gap-2">
              <span className={cn('h-1.5 w-1.5 rounded-full', TIER_STYLE[t].dot)} />
              <span className="text-[11.5px] font-medium text-zinc-400">{TIER_STYLE[t].groupLabel}</span>
              <span className="h-px flex-1 bg-gradient-to-r from-void-700 to-transparent" />
            </div>
            <div className="space-y-2">
              {byTier(t).map((src) => (
                <SourceCard key={src.id} src={src} cfg={data.reconSources[src.id]} verify={verify?.[src.id]} onSave={saveSource(src.id)} />
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
