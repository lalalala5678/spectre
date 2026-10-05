import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { Loader2, Check, AlertTriangle, RotateCw, Sparkles, ShieldCheck, Eye, EyeOff } from 'lucide-react';
import { cn } from '../utils/cn';
import { AgentLlmOverride } from '../components/AgentLlmOverride';
import { hasCred } from '../utils/hasCred';
import type { LlmFormatMeta } from '../api/llmFormats';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Input, Select } from '../components/ui/Input';
import { Skeleton } from '../components/ui/Skeleton';
import { usePageTitle } from '../utils/usePageTitle';

/**
 * 设置页 — 通用配置(全局)+ Agent 特有配置(数据源/LLM 覆盖)。
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
    llmFormats: LlmFormatMeta[];
    common: { label: string; fields: FieldDef[] };
    agents: { agentKey: string; label: string; hint?: string; sources: SourceDef[] }[];
    agentLlm: { agentKey: string; label: string; hint?: string; fields: FieldDef[] }[];
  };
}

const TIER_STYLE: Record<string, { label: string; tone: BadgeTone; dot: string; groupLabel: string }> = {
  P0: { label: 'P0', tone: 'danger', dot: 'bg-danger-text', groupLabel: '必配 · 三大结构性缺口(fofa/github/cse)' },
  P1: { label: 'P1', tone: 'warning', dot: 'bg-warning-text', groupLabel: '建议 · 免费层够用' },
  P2: { label: 'P2', tone: 'neutral', dot: 'bg-faint', groupLabel: '增益 · 多源并集提覆盖' },
};

/** 单字段行:label + input/select + 保存按钮(未保存高亮/转圈/成功/失败态) */
function FieldRow({ def, value, onSave, onDirtyChange, revealCtx }: {
  def: FieldDef;
  value: string | number | undefined;
  onSave: (v: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;  // FEVERIFY6-P3: 脏离开提示
  revealCtx?: { kind: 'common' | 'source'; id: string };  // EQ-4: password 眼睛
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
  // EQ-4: 小眼睛——密码类字段点击查看存量明文(后端留审计)
  const [peek, setPeek] = useState(false);
  const [peekVal, setPeekVal] = useState('');
  const togglePeek = async () => {
    if (peek) { setPeek(false); return; }
    if (!revealCtx) return;
    try {
      const r = await api<{ value: string }>('/agent-settings/reveal', {
        method: 'POST', json: { kind: revealCtx.kind, id: revealCtx.id, field: def.id.split('.').pop() ?? def.id } });
      setPeekVal(r.value || '(空)'); setPeek(true);
    } catch { setPeekVal('(查看失败)'); setPeek(true); }
  };
  // FEVERIFY9-P2: 拆两 effect——[dirty] 只上报, [] 只管卸载(此前 cleanup
  // 在每次 dirty 变迁也执行, 相对计数被 -2 双发 → 欠账 → 守卫旁路)
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]);  // eslint-disable-line react-hooks/exhaustive-deps
  // 卸载归零(一次性, 仅卸载时执行)
  useEffect(() => () => onDirtyChange?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

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
    <div className="group grid grid-cols-[minmax(150px,230px)_1fr_auto] items-center gap-3 max-md:grid-cols-1 py-2.5 pr-2 transition-colors hover:bg-surface-2/40">
      <div className="min-w-0 pl-1">
        <label htmlFor={`fld-${def.id}`} className="block text-[13px] font-medium text-secondary">{def.label}</label>
        {/* 用户令: 字段说明一律不渲染 */}
      </div>
      <div className="min-w-0">
        {def.type === 'select' ? (
          <Select
            id={`fld-${def.id}`}
            aria-label={def.label}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="max-w-md"
          >
            {(def.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </Select>
        ) : (
          <div className="relative max-w-md">
            <Input
              id={`fld-${def.id}`}
              type={def.type === 'password' && !peek ? 'password' : def.type === 'number' ? 'number' : 'text'}
              value={def.type === 'password' && peek ? peekVal : draft}
              readOnly={def.type === 'password' && peek}
              placeholder={def.placeholder}
              onChange={(e) => { setDraft(e.target.value); if (state !== 'saving') setState('idle'); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
              className={cn('w-full',
                (def.id.endsWith('apiKey') || def.id.endsWith('baseUrl')) && 'font-mono text-[13px]',
                state === 'err' ? 'border-danger-line' : dirty && 'border-accent')}
            />
            {def.type === 'password' && revealCtx && (
              <button type="button" onClick={() => void togglePeek()}
                aria-label={peek ? '隐藏明文' : '查看明文'} title={peek ? '隐藏明文' : '查看明文(操作会留审计日志)'}
                className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-tertiary hover:bg-surface-2 hover:text-primary">
                {peek ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            )}
          </div>
        )}
        {state === 'err' && (
          <div className="mt-1.5 flex items-start gap-1.5 rounded-md border border-danger-line bg-danger-bg px-2 py-1 text-[13px] leading-snug text-danger-text">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{msg || '校验失败'}
          </div>
        )}
      </div>
      <Button
        onClick={() => void save()}
        disabled={!dirty || state === 'saving'}
        variant="primary"
        size="sm"
        className={cn('min-w-20',
          state === 'ok' && 'border-success-line bg-success-bg text-success-text hover:bg-success-bg')}
      >
        {state === 'saving'
          ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />检测中</>
          : state === 'ok'
            ? <><Check className="h-3.5 w-3.5" />已保存</>
            : '保存'}
      </Button>
    </div>
  );
}

/** 数据源卡片(带 tier 徽章 + 挂载状态) */
function SourceCard({ src, cfg, onSave, verify, onDirtyChange }: {
  src: SourceDef;
  cfg: Record<string, string> | undefined;
  onSave: (leaf: string) => (v: string) => Promise<void>;
  verify?: { ok: boolean; error?: string | null };
  onDirtyChange?: (dirty: boolean) => void;  // FEVERIFY6-P3: 透传脏态
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
    <div className="overflow-hidden transition-colors">  {/* 单框: 源不自带卡 */}
      <button
        onClick={() => setOpen(!open)}
        className="flex min-h-12 w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-surface-2/40"
      >
        <span className={cn('h-2 w-2 shrink-0 rounded-full', mounted ? 'bg-success-text' : tier.dot)} />
        <span className="text-[13px] font-medium text-primary">{String(src.label).replace(/\s*[（(][^）)]*[）)]/g, '')}</span>
        <Badge tone={verifyState && !verifyState.ok ? 'danger' : mounted ? 'success' : 'neutral'} className="ml-auto shrink-0">
          {verifyState && !verifyState.ok
            ? 'key 已失效 · 不注入'
            : isParams ? `参数组 · ${paramCount} 项已注入`
            : mounted ? (verifyState ? '已验证 · 已注入' : '已挂载 MCP') : '未配置 · 不注入'}
        </Badge>
        {verifyState && !verifyState.ok && verifyState.error && (
          <span className="max-w-[220px] truncate font-mono text-xs text-danger-text/80" title={verifyState.error}>{verifyState.error}</span>
        )}
        <svg className={cn('h-3.5 w-3.5 shrink-0 text-tertiary transition-transform', open && 'rotate-90')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>
      {open && (
        <div className="divide-y divide-line border-t border-line">
          {src.fields.map((f) => (
            <FieldRow
              onDirtyChange={onDirtyChange}
              revealCtx={{ kind: 'source', id: src.id }}
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

/* r47: 渗透授权(scope)——前端可配置(用户令: 打新靶不用上服务器改 json)。
 * targets chips 增删 + 演习窗口; PUT /api/scope 即时生效(shell 硬门每
 * 次读盘)。 */
function ScopeSection() {
  const [scope, setScope] = useState<{ targets: string[]; exercise: string; window: { start: string; end: string } | null } | null>(null);
  const [draftTarget, setDraftTarget] = useState('');
  const [saving, setSaving] = useState(false);
  const load = () => api<typeof scope>('/scope').then(setScope);
  useEffect(() => { void load(); }, []);
  const save = async (next: NonNullable<typeof scope>) => {
    setSaving(true);
    try {
      const r = await api<typeof scope>('/scope', { method: 'PUT', json: next });
      setScope(r);
    } finally { setSaving(false); }
  };
  const addTarget = () => {
    const t = draftTarget.trim();
    if (!t || !scope || scope.targets.includes(t)) return;
    setDraftTarget('');
    void save({ ...scope, targets: [...scope.targets, t] });
  };
  return (
    <section className="mb-8 overflow-hidden rounded-lg border border-line bg-surface shadow-xs">
      <div className="flex items-center gap-2 border-b border-line bg-surface-2/50 px-4 py-3">
        <span className="text-[13px] font-medium text-primary">渗透授权清单</span>
        {saving && <span className="text-[11px] text-tertiary">保存中…</span>}
      </div>
      <div className="space-y-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {scope?.targets.map(t => (
            <span key={t} className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface px-2 py-0.5 font-mono text-xs text-secondary">
              {t}
              <button
                onClick={() => scope && save({ ...scope, targets: scope.targets.filter(x => x !== t) })}
                className="text-tertiary hover:text-danger-text"
                aria-label={`删除 ${t}`}
              >×</button>
            </span>
          ))}
          <input
            value={draftTarget}
            onChange={e => setDraftTarget(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTarget(); } }}
            placeholder="目标名(如 10.0.0.5 / host.example.com)"
            className="h-7 w-56 rounded-md border border-line bg-surface px-2 text-xs text-primary outline-none focus:border-accent"
          />
          <Button size="sm" variant="primary" onClick={addTarget} disabled={!draftTarget.trim()}>添加</Button>
        </div>
        {scope?.window && (
          <div className="flex items-center gap-2 text-xs text-tertiary">
            <span>演习窗口</span>
            <input type="date" value={scope.window.start.slice(0, 10)}
              onChange={e => scope && save({ ...scope, window: { start: new Date(e.target.value).toISOString(), end: scope.window!.end } })}
              className="h-7 rounded-md border border-line bg-surface px-2 text-xs" />
            <span>→</span>
            <input type="date" value={scope.window.end.slice(0, 10)}
              onChange={e => scope && save({ ...scope, window: { start: scope.window!.start, end: new Date(e.target.value).toISOString() } })}
              className="h-7 rounded-md border border-line bg-surface px-2 text-xs" />
          </div>
        )}
      </div>
    </section>
  );
}

export function SettingsPage() {
  // FEVERIFY6-P3: 未保存改动计数——派发全局事件, App 路由切换前拦截确认
  // FEVERIFY8-勘误: 协议 v2 绝对值(src='settings'); 上一批 LLM 两调用点
  // 接线实际未写入(replace 未中未断言)——本次三处全接线。
  const dirtyCount = useRef(0);
  const SRC = 'settings';
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('spectre:dirty-set', { detail: { src: SRC, count: dirtyCount.current } }));
    return () => {
      dirtyCount.current = 0;
      window.dispatchEvent(new CustomEvent('spectre:dirty-zero', { detail: { src: SRC } }));
    };
  }, []);
  const bumpDirty = (d: boolean) => {
    dirtyCount.current = Math.max(0, dirtyCount.current + (d ? 1 : -1));
    window.dispatchEvent(new CustomEvent('spectre:dirty-set', { detail: { src: SRC, count: dirtyCount.current } }));
  };
  usePageTitle('设置'); // FEVERIFY-N3
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [err, setErr] = useState('');
  const [verify, setVerify] = useState<Record<string, { ok: boolean; error?: string | null }> | null>(null);
  const [verifying, setVerifying] = useState(false);
  // R32D70: 复查结果全局摘要(新装机零 recon 源时按钮此前零反馈——
  // verifyState 只在源卡片渲染)。
  const [verifySummary, setVerifySummary] = useState('');
  const runVerify = () => {
    setVerifying(true); setVerifySummary('');
    api<{ results: { id: string; ok?: boolean; error?: string | null }[] }>('/agent-settings/verify')
      .then((r) => {
        const m: Record<string, { ok: boolean; error?: string | null }> = {};
        for (const it of r.results) if (it.ok !== undefined) m[it.id] = { ok: it.ok, error: it.error };
        setVerify(m);
        const n = Object.keys(m).length;
        const ok = Object.values(m).filter(v => v.ok).length;
        setVerifySummary(n ? `复查完成: ${ok}/${n} 个数据源可用${ok < n ? '(失败项见各源卡片红标)' : ''}`
          : '无可复查的数据源(先在下方配置至少一家)');
      })
      .catch(() => { setVerify(null); setVerifySummary('复查失败(接口错误)'); })
      .finally(() => setVerifying(false));
  };

  const reload = () => api<SettingsPayload>('/agent-settings')
    .then(d => { setData(d); setErr(''); })  // FEVERIFY-P3-5: 成功清旧错(加载错不得滞留成保存错)
    .catch((e) => setErr(`加载失败: ${e instanceof Error ? e.message : String(e)}`));

  useEffect(() => { void reload(); }, []);

  const saveCommon = (fieldId: string) => async (v: string) => {
    await api('/agent-settings/save', { method: 'POST', json: { group: 'common', field: fieldId, value: v } });
    await reload();
  };
  const saveSource = (srcId: string, group = 'recon-source') => (leaf: string) => async (v: string) => {
    await api('/agent-settings/save', { method: 'POST', json: { group, field: `${srcId}.${leaf}`, value: v } });
    await reload();
  };

  // EQ-3: 二级菜单——左锚点分组导航(替代单页倾倒)
  // FEVERIFY11-P3: scroll-spy 高亮 + <lg 横向 chips(窄屏不整体消失)
  const SECTIONS = [
    { id: 'sec-common', label: '通用与模型' },
    { id: 'sec-agentllm', label: '按智能体换模型' },
    { id: 'sec-agents', label: '智能体专属配置' },
    { id: 'sec-scope', label: '渗透授权' },
  ];
  const [activeSec, setActiveSec] = useState('sec-common');
  const scrollHostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = scrollHostRef.current;
    if (!host) return;
    const onScroll = () => {
      const line = host.getBoundingClientRect().top + 140;
      let cur = SECTIONS[0].id;
      for (const sec of SECTIONS) {
        const el = document.getElementById(sec.id);
        if (el && el.getBoundingClientRect().top <= line) cur = sec.id;
      }
      setActiveSec(cur);
    };
    host.addEventListener('scroll', onScroll, { passive: true });
    return () => host.removeEventListener('scroll', onScroll);
    // FEVERIFY13-P3-11: 依赖 data——骨架帧 scrollHostRef=null 且 [] 不重跑,
    // listener 永不绑定(scroll-spy 全死)。data 到达后重跑绑定。
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const goSec = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (err) return <div className="p-6 text-sm text-danger-text">设置加载失败:{err}</div>;
  if (!data) return <div className="space-y-3 p-6">
    <Skeleton className="h-8 w-full" />
    <Skeleton className="h-24 w-full" />
    <Skeleton className="h-24 w-full" />
  </div>;

  const cs = data.common ?? {};
  const llm = (cs.llm ?? {}) as Record<string, string>;
  const comp = (cs.compaction ?? {}) as Record<string, string>;
  const ws = (cs.webSearch ?? {}) as Record<string, string>;
  const groups = data.schema.agents ?? [];
  // 用户令: 资产测绘数据源=资产测绘 agent 专属配置——并入智能体专属分组
  const otherAgents = groups;
  const groupOf = (agentKey: string) => (agentKey === 'weakcred' ? 'weakcred' : 'recon-source');

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="设置分组" className="hidden w-44 shrink-0 flex-col gap-0.5 border-r border-line px-3 py-4 lg:flex">
        {SECTIONS.map(sec => (
          <button key={sec.id} onClick={() => goSec(sec.id)}
            className={cn('rounded-md px-2.5 py-2 text-left text-[13px] transition-colors',
              activeSec === sec.id ? 'bg-accent-subtle font-medium text-accent-text' : 'text-secondary hover:bg-surface-2 hover:text-primary')}>
            {sec.label}
          </button>
        ))}
      </nav>
      <div ref={scrollHostRef} className="mx-auto min-w-0 max-w-4xl flex-1 overflow-y-auto px-6 py-6">
        {/* FEVERIFY11-P3-4: <lg 横向分组 chips(窄屏二级菜单形态) */}
        <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1 lg:hidden">
          {SECTIONS.map(sec => (
            <button key={sec.id} onClick={() => goSec(sec.id)}
              className={cn('shrink-0 rounded-full border px-3 py-1.5 text-xs transition-colors',
                activeSec === sec.id ? 'border-accent-text bg-accent-subtle text-accent-text' : 'border-line bg-surface text-secondary hover:bg-surface-2')}>
              {sec.label}
            </button>
          ))}
        </div>
      {/* 标题 + 概览 */}
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-[16px] font-medium text-primary">
            <Sparkles className="h-4 w-4 text-accent-text" />设置
          </h1>
          <p className="mt-1 text-[13px] text-tertiary">
            修改后逐项保存;保存前会做真实连通校验,校验不通过不会写入。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => void runVerify()} disabled={verifying} variant="secondary" size="sm" className="mb-1">
            {verifying ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />复查中</> : <><ShieldCheck className="h-3.5 w-3.5" />复查可用性</>}
          </Button>
          {verifySummary && <span className="mb-1 text-[13px] text-tertiary">{verifySummary}</span>}
          <Button onClick={() => void reload()} title="刷新" variant="ghost" size="icon" className="mb-1">
            <RotateCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* ---------- 通用配置(全局) ---------- */}
      <section id="sec-common" className="mb-8 scroll-mt-4 overflow-hidden rounded-lg border border-line bg-surface shadow-xs">
        <div className="flex items-center gap-2 border-b border-line bg-surface-2/50 px-4 py-3">
          <ShieldCheck className="h-3.5 w-3.5 text-tertiary" />
          <span className="text-[13px] font-medium text-primary">{String(data.schema.common.label).replace(/\s*[（(][^）)]*[）)]/g, '')}</span>
        </div>
        <div className="divide-y divide-line">
          {/* R32D45-N1: llm 四字段(格式/URL/Key/模型)走原子编辑器——
              逐字段保存×合并探测有跨厂商中间态死锁(换供应商先存 URL
              的瞬间=新 URL+旧 key→401 存不进)。 */}
          <div className="px-4 py-2.5">
            <AgentLlmOverride agentId="" mode="default" formats={data.schema.llmFormats} onDirtyChange={bumpDirty} ov={{
              format: String(llm.format ?? ''), baseUrl: String(llm.baseUrl ?? ''),
              apiKey: String(llm.apiKey ?? ''), model: String(llm.model ?? ''),
            }} onSaved={() => void reload()} />
          </div>
          {data.schema.common.fields.map((f) => {
            const [top, leaf] = f.id.split('.');
            // CS16-P2: webSearch 三字段此前落空 bucket(只认 llm/comp)——
            // 保存后回显恒空, 用户以为没存上。
            const bucket = top === 'llm' ? llm : (top === 'webSearch' ? ws : comp);
            return <FieldRow key={f.id} def={f} value={bucket[leaf]} onSave={saveCommon(f.id)} onDirtyChange={bumpDirty} revealCtx={{ kind: 'common', id: top }} />;
          })}
        </div>
      </section>

      {/* ---------- R32D44: 单 Agent 大模型供应商覆盖 ---------- */}
      <section id="sec-agentllm" className="mb-8 scroll-mt-4 overflow-hidden rounded-lg border border-line bg-surface shadow-xs">
        <div className="flex items-center gap-2 border-b border-line bg-surface-2/50 px-4 py-3">
          <span className="text-[13px] font-medium text-primary">单 Agent 大模型覆盖</span>
        </div>
        <div className="divide-y divide-line">
          {(data.schema.agentLlm ?? []).map((g) => {
            const ov = data.agentLlm?.[g.agentKey] ?? {};
            return (
              <div key={g.agentKey} className="px-4 py-2.5">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-[13px] font-medium text-secondary">{g.label}</span>
                  {/* 用户令: 状态徽章删(“用默认/已覆盖”) */}
                </div>
                {/* CS16-P1: 原子四字段编辑器(与 agent 配置页签同款共享组件)——
                    逐字段保存×整体探测有跨供应商中间态死锁 */}
                <AgentLlmOverride agentId={g.agentKey} formats={data.schema.llmFormats} ov={ov} onSaved={() => void reload()} onDirtyChange={bumpDirty} />
              </div>
            );
          })}
        </div>
      </section>

      {/* ---------- 其它 Agent 参数/数据源组(爆破参数·NDay 等) ---------- */}
      <div id="sec-agents" className="scroll-mt-4" />
      {otherAgents.map((agent) => (
        <section key={agent.agentKey} className="mb-8 overflow-hidden rounded-lg border border-line bg-surface shadow-xs">
          <div className="flex items-center gap-2 border-b border-line bg-surface-2/50 px-4 py-3">
            <span className="text-[13px] font-medium text-primary">{String(agent.label).replace(/\s*[（(][^）)]*[）)]/g, '')}</span>
          </div>
          {/* 用户令: 说明不渲染 */}
          {agent.sources.length === 0 ? (
            <div className="px-4 py-3 text-[13px] text-tertiary">该智能体无独立数据源配置。</div>
          ) : (
            <div className="divide-y divide-line">
              {agent.sources.map((src) => (
                <SourceCard onDirtyChange={bumpDirty} key={src.id} src={src} cfg={data.reconSources[src.id]} verify={verify?.[src.id]} onSave={saveSource(src.id, groupOf(agent.agentKey))} />
              ))}
            </div>
          )}
        </section>
      ))}
      <div id="sec-scope" className="scroll-mt-4" />
      <ScopeSection />
      </div>
    </div>
  );
}
