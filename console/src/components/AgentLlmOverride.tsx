import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { cn } from '../utils/cn';
import type { LlmFormatMeta } from '../api/llmFormats';

/** R32D44-llm: 供应商四字段原子编辑器(设置页与 agent 配置页签共用)。
 * 保存协议(CS16-P1/R32D45-N1 原子提交): 四字段一个请求整体提交, 后端
 * 用完整生效配置做真实连通探测, 失败零落盘。
 * - mode='override'(默认): agent 覆盖——留空字段=清除该项回默认。
 * - mode='default': 默认供应商——三项必填(格式默认 openai)。 */
export function AgentLlmOverride({ agentId, ov, onSaved, mode = 'override', formats }: {
  agentId: string; ov?: Record<string, string>; onSaved: () => void;
  mode?: 'override' | 'default';
  formats: LlmFormatMeta[];  // CS19-4/CS20-7/CS21-3: schema 单源必传
}) {

  const isDefault = mode === 'default';
  const [draft, setDraft] = useState({ format: '', baseUrl: '', apiKey: '', model: '' });
  const [orig, setOrig] = useState({ format: '', baseUrl: '', apiKey: '', model: '' });
  const [state, setState] = useState<'idle' | 'saving' | 'ok' | 'err'>('idle');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    const v = { format: ov?.format ?? '', baseUrl: ov?.baseUrl ?? '', apiKey: ov?.apiKey ?? '', model: ov?.model ?? '' };
    setDraft(v); setOrig(v); setState('idle'); setMsg('');
  }, [agentId, ov?.format, ov?.baseUrl, ov?.apiKey, ov?.model]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(orig);

  const save = async () => {
    if (!dirty || state === 'saving') return;
    if (isDefault && (!draft.baseUrl || !draft.apiKey || !draft.model)) {
      setState('err'); setMsg('默认供应商三项必填(Base URL/API Key/模型)');
      return;
    }
    setState('saving'); setMsg('');
    // CS16-P1/R32D45-N1: 原子提交——四字段整体一个请求, 后端用完整
    // 生效配置一次探测。此前逐字段保存×整体探测有中间态死锁: 换供应
    // 商时先存 URL 的瞬间=新 URL+旧 key→探测 401 永远存不进。
    try {
      await api('/agent-settings/save', { method: 'POST',
        json: isDefault
          ? { group: 'common', field: 'llm',
              value: { format: draft.format || 'openai', baseUrl: draft.baseUrl, apiKey: draft.apiKey, model: draft.model } }
          : { group: 'agent-llm', field: agentId,
              value: { format: draft.format, baseUrl: draft.baseUrl, apiKey: draft.apiKey, model: draft.model } } });
    } catch (e) {
      setState('err'); setMsg(e instanceof Error ? e.message : String(e)); return;
    }
    // R32D67-C: 表单回写 trim 后值(落盘已 trim——此前显示/持久分叉)。
    const saved = { format: (draft.format || 'openai').trim(), baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey, model: draft.model.trim() };
    setDraft(saved); setOrig(saved);
    setState('ok'); setMsg('已保存(通过连通探测)'); onSaved();
    setTimeout(() => setState('idle'), 2500);
  };

  const overridden = Boolean(orig.baseUrl || orig.apiKey || orig.model || orig.format);
  // 字段行渲染(非组件——oxlint react/static-components)
  const field = (k: 'format' | 'baseUrl' | 'apiKey' | 'model', label: string, ph: string, type = 'text') => (
    <label key={k} className="flex items-center gap-2">
      <span className="w-[86px] shrink-0 text-[10.5px] text-zinc-500">{label}</span>
      {k === 'format' ? (
        <select value={draft.format} onChange={e => setDraft(d => ({ ...d, format: e.target.value }))}
          className="min-w-0 flex-1 rounded-sm border border-void-600 bg-void-950 px-2 py-1 font-mono text-[11px] text-zinc-200 outline-none focus:border-orange-700">
          {isDefault
            ? <option value="">openai(默认)</option>
            : <option value="">(继承默认)</option>}
          {formats.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      ) : (
        <input type={type} value={draft[k]} placeholder={ph} onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))}
          className="min-w-0 flex-1 rounded-sm border border-void-600 bg-void-950 px-2 py-1 font-mono text-[11px] text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-orange-700" />
      )}
    </label>
  );

  return (
    <div className="rounded-sm border border-void-700 bg-void-900/60 p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-zinc-300">
          {isDefault ? '默认大模型供应商' : '本 agent 覆盖'}
          {!isDefault && overridden && <span className="ml-1.5 rounded-sm bg-orange-950/60 px-1.5 py-0.5 font-mono text-[9px] text-orange-300">已覆盖</span>}
          {!isDefault && !overridden && <span className="ml-1.5 font-mono text-[9.5px] text-zinc-600">当前=默认供应商</span>}
        </span>
        <button onClick={() => void save()} disabled={!dirty || state === 'saving'}
          className={cn('flex items-center gap-1 rounded-sm border px-2.5 py-1 font-mono text-[10.5px] transition-colors disabled:opacity-40',
            dirty ? 'border-orange-600 bg-orange-600/20 text-orange-300 hover:bg-orange-600/30' : 'border-void-600 text-zinc-500')}>
          {state === 'saving' ? '探测中…' : state === 'ok' ? '✓ 已保存' : '保存并探测'}
        </button>
      </div>
      <div className="space-y-1.5">
        {field('format', '接口格式', '')}
        {/* R32D45-N3/CS19-4: 适配说明按选中格式从 schema 下发的
            单源数据渲染。 */}
        <p className="pl-[94px] font-mono text-[9.5px] text-zinc-600">
          {draft.format === '' && !isDefault ? '继承默认供应商的格式'
            : (formats.find(f => f.id === (draft.format || 'openai'))?.hint ?? '')}
        </p>
        {field('baseUrl', 'Base URL', isDefault ? 'https://open.bigmodel.cn/api/paas/v4' : '留空=用默认')}
        {field('apiKey', 'API Key', isDefault ? '' : '留空=用默认', 'password')}
        {field('model', '模型名称', isDefault ? 'glm-4.7' : '留空=用默认')}
      </div>
      <p className={cn('mt-1.5 truncate font-mono text-[10px]', state === 'err' ? 'text-red-400' : 'text-zinc-600')} title={msg}>
        {state === 'err' ? msg : isDefault ? '四字段一个请求保存+真实连通探测(换供应商一步到位)' : '保存会用覆盖后的完整配置做真实连通探测; 清除=保存空值回默认'}
      </p>
    </div>
  );
}
