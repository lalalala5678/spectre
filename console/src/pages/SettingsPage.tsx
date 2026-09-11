import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Loader2, Check, AlertTriangle, RotateCw } from 'lucide-react';

/**
 * Agent 设置栏 — 通用配置(全局)+ Agent 特有配置(本轮:资产测绘数据源)。
 *
 * 交互铁律(用户设计):每个字段独立一个保存按钮;改动后按钮高亮(未保存),
 * 点击 → 转圈(后端用所填值做真实连通探测/范围校验)→ 失败红字报错不保存,
 * 成功绿色打勾落盘。枚举用下拉,文本/数值用输入框。
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
interface SettingsPayload {
  common: Record<string, Record<string, string | number>> | null;
  reconSources: Record<string, Record<string, string>>;
  schema: {
    common: { label: string; fields: FieldDef[] };
    agents: {
      agentKey: string; label: string; hint?: string;
      sources: { id: string; label: string; defaultBase: string; fields: FieldDef[] }[];
    }[];
  };
}

/** 单字段行:label + input/select + 保存按钮(未保存高亮/转圈/成功/失败态) */
function FieldRow({
  def, value, onSave,
}: {
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
    if (!dirty) return;
    setState('saving'); setMsg('');
    try {
      await onSave(draft);
      setOrig(draft); setState('ok');
      setTimeout(() => setState('idle'), 1600);
    } catch (e) {
      setState('err'); setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="grid grid-cols-[minmax(160px,240px)_1fr_auto] items-center gap-3 py-2">
      <div className="min-w-0">
        <div className="text-[12.5px] text-zinc-300">{def.label}</div>
        {def.hint && <div className="mt-0.5 text-[10.5px] leading-tight text-zinc-600">{def.hint}</div>}
      </div>
      <div className="min-w-0">
        {def.type === 'select' ? (
          <select
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full max-w-md rounded-sm border border-void-600 bg-void-950 px-2 py-1.5 font-mono text-[12.5px] text-zinc-200 outline-none focus:border-void-500"
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
            className={`w-full max-w-md rounded-sm border bg-void-950 px-2 py-1.5 font-mono text-[12.5px] text-zinc-200 outline-none ${
              state === 'err' ? 'border-red-800' : dirty ? 'border-orange-700' : 'border-void-600 focus:border-void-500'}`}
          />
        )}
        {state === 'err' && (
          <div className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-red-400">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{msg || '校验失败'}
          </div>
        )}
      </div>
      <button
        onClick={() => void save()}
        disabled={!dirty || state === 'saving'}
        className={`flex items-center gap-1.5 rounded-sm border px-3 py-1.5 font-mono text-[11.5px] transition-colors
          ${state === 'ok' ? 'border-emerald-700 text-emerald-400'
            : dirty && state !== 'saving' ? 'border-orange-600 bg-orange-950/40 text-orange-300 hover:bg-orange-900/40'
            : 'border-void-700 text-zinc-600 cursor-default'}`}
      >
        {state === 'saving'
          ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />检测中</>
          : state === 'ok'
            ? <><Check className="h-3.5 w-3.5" />已保存</>
            : dirty ? '保存' : '保存'}
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [err, setErr] = useState('');

  const reload = () => api<SettingsPayload>('/agent-settings')
    .then(setData)
    .catch((e) => setErr(e instanceof Error ? e.message : String(e)));

  useEffect(() => { void reload(); }, []);

  const saveCommon = (fieldId: string) => async (v: string) => {
    await api('/agent-settings/save', { method: 'POST', json: { group: 'common', field: fieldId, value: v } });
    await reload();
  };
  const saveSource = (srcId: string, leaf: string) => async (v: string) => {
    await api('/agent-settings/save', { method: 'POST', json: { group: 'recon-source', field: `${srcId}.${leaf}`, value: v } });
    await reload();
  };

  if (err) return <div className="p-6 text-red-400">设置加载失败:{err}</div>;
  if (!data) return <div className="p-6 text-zinc-500">加载中…</div>;

  const cs = data.common ?? {};
  const llm = (cs.llm ?? {}) as Record<string, string>;
  const comp = (cs.compaction ?? {}) as Record<string, string>;

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <div className="mb-1 flex items-center gap-2">
        <h1 className="text-[15px] font-medium text-zinc-100">Agent 配置</h1>
        <button onClick={() => void reload()} title="刷新"
          className="text-zinc-600 hover:text-zinc-300"><RotateCw className="h-3.5 w-3.5" /></button>
      </div>
      <p className="mb-5 text-[11.5px] text-zinc-500">
        每条配置独立保存:点击保存后先用所填值做真实连通检测/范围校验,失败不落盘。
      </p>

      {/* ---------- 通用配置(全局) ---------- */}
      <section className="mb-8 rounded border border-void-700 bg-void-900/30">
        <div className="border-b border-void-700 px-4 py-2.5 text-[12.5px] text-zinc-200">
          {data.schema.common.label}
        </div>
        <div className="divide-y divide-void-800 px-4">
          {data.schema.common.fields.map((f) => {
            const [top, leaf] = f.id.split('.');
            const bucket = top === 'llm' ? llm : comp;
            return (
              <FieldRow key={f.id} def={f} value={bucket[leaf]} onSave={saveCommon(f.id)} />
            );
          })}
        </div>
      </section>

      {/* ---------- Agent 特有配置 ---------- */}
      {data.schema.agents.map((ag) => {
        const mounted = (id: string) => {
          const cfg = data.reconSources[id];
          return Boolean(cfg && (cfg.key || cfg.token || cfg.secret || cfg.id));
        };
        return (
          <section key={ag.agentKey} className="mb-8 rounded border border-void-700 bg-void-900/30">
            <div className="flex items-center justify-between border-b border-void-700 px-4 py-2.5">
              <div className="text-[12.5px] text-zinc-200">{ag.label}</div>
              <span className="font-mono text-[10.5px] text-zinc-600">
                已启用 {ag.sources.filter((s) => mounted(s.id)).length}/{ag.sources.length} 个源
              </span>
            </div>
            {ag.hint && <div className="border-b border-void-800 px-4 py-2 text-[11px] leading-relaxed text-zinc-500">{ag.hint}</div>}
            {ag.sources.map((src) => (
              <div key={src.id} className="border-b border-void-800 last:border-0">
                <div className="flex items-center gap-2 bg-void-900/50 px-4 py-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${mounted(src.id) ? 'bg-emerald-500' : 'bg-zinc-700'}`} />
                  <span className="text-[11.5px] text-zinc-300">{src.label}</span>
                  <span className="font-mono text-[10px] text-zinc-600">
                    {mounted(src.id) ? '已挂载 MCP 工具' : '未配置(不注入)'}
                  </span>
                </div>
                <div className="divide-y divide-void-800 px-4">
                  {src.fields.map((f) => (
                    <FieldRow
                      key={f.id}
                      def={{ ...f, placeholder: f.placeholder ?? (f.id.endsWith('baseUrl') ? `默认 ${src.defaultBase}` : undefined) }}
                      value={data.reconSources[src.id]?.[f.id.split('.')[1]]}
                      onSave={saveSource(src.id, f.id.split('.')[1])}
                    />
                  ))}
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
