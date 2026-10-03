import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { cn } from '../utils/cn';
import type { LlmFormatMeta } from '../api/llmFormats';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Input, Select } from './ui/Input';

/** R32D44-llm: 供应商四字段原子编辑器(设置页与 agent 配置页签共用)。
 * 保存协议(CS16-P1/R32D45-N1 原子提交): 四字段一个请求整体提交, 后端
 * 用完整生效配置做真实连通探测, 失败零落盘。
 * - mode='override'(默认): agent 覆盖——留空字段=清除该项回默认。
 * - mode='default': 默认供应商——三项必填(格式默认 openai)。 */
export function AgentLlmOverride({ agentId, ov, onSaved, mode = 'override', formats, onDirtyChange }: {
  agentId: string; ov?: Record<string, string>; onSaved: () => void;
  mode?: 'override' | 'default';
  formats: LlmFormatMeta[];  // CS19-4/CS20-7/CS21-3: schema 单源必传
  onDirtyChange?: (dirty: boolean) => void;  // FEVERIFY7-P3: 脏离开接线
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
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]);  // eslint-disable-line react-hooks/exhaustive-deps

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
      <span className="w-[86px] shrink-0 text-[13px] text-secondary">{label}</span>
      {k === 'format' ? (
        <Select value={draft.format} onChange={e => setDraft(d => ({ ...d, format: e.target.value }))}
          className="min-w-0 flex-1">
          {isDefault
            ? <option value="">openai(默认)</option>
            : <option value="">(继承默认)</option>}
          {formats.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </Select>
      ) : (
        <Input type={type} value={draft[k]} placeholder={ph} onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))}
          className="min-w-0 flex-1 font-mono text-[13px]" />
      )}
    </label>
  );

  return (
    <div className="rounded-md border border-line bg-surface p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-secondary">
          {isDefault ? '默认大模型供应商' : '本 agent 覆盖'}
          {!isDefault && overridden && <Badge tone="accent">已覆盖</Badge>}
          {!isDefault && !overridden && <span className="text-xs text-tertiary">当前=默认供应商</span>}
        </span>
        <Button onClick={() => void save()} disabled={!dirty || state === 'saving'} variant="primary" size="sm">
          {state === 'saving' ? '探测中…' : state === 'ok' ? '✓ 已保存' : '保存并探测'}
        </Button>
      </div>
      <div className="space-y-1.5">
        {field('format', '接口格式', '')}
        {/* R32D45-N3/CS19-4: 适配说明按选中格式从 schema 下发的
            单源数据渲染。 */}
        <p className="pl-[94px] text-xs text-tertiary">
          {draft.format === '' && !isDefault ? '继承默认供应商的格式'
            : (formats.find(f => f.id === (draft.format || 'openai'))?.hint ?? '')}
        </p>
        {field('baseUrl', 'Base URL', isDefault ? 'https://open.bigmodel.cn/api/paas/v4' : '留空=用默认')}
        {field('apiKey', 'API Key', isDefault ? '' : '留空=用默认', 'password')}
        {field('model', '模型名称', isDefault ? 'glm-4.7' : '留空=用默认')}
      </div>
      <p className={cn('mt-1.5 truncate text-xs', state === 'err' ? 'text-danger-text' : 'text-tertiary')} title={msg}>
        {state === 'err' ? msg : isDefault ? '四字段一个请求保存+真实连通探测(换供应商一步到位)' : '保存会用覆盖后的完整配置做真实连通探测; 清除=保存空值回默认'}
      </p>
    </div>
  );
}
