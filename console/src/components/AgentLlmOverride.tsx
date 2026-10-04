import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
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
  // FEVERIFY9-P2: 同 FieldRow——拆 effect 消 cleanup 双发欠账
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]);  // eslint-disable-line react-hooks/exhaustive-deps
  // 卸载归零(一次性, 仅卸载时执行)
  useEffect(() => () => onDirtyChange?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

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
  const [peek, setPeek] = useState(false);
  const [peekVal, setPeekVal] = useState('');
  const togglePeek = async () => {
    if (peek) { setPeek(false); return; }
    try {
      const r = await api<{ value: string }>('/agent-settings/reveal', {
        method: 'POST', json: { kind: isDefault ? 'llm-default' : 'llm-agent', id: agentId, field: 'apiKey' } });
      setPeekVal(r.value || '(空)'); setPeek(true);
    } catch { setPeekVal('(查看失败)'); setPeek(true); }
  };
  const field = (k: 'format' | 'baseUrl' | 'apiKey' | 'model', label: string, ph: string, type = 'text') => (
    <label key={k} className="flex items-center gap-2">
      <span className="w-[86px] shrink-0 text-[13px] text-secondary">{label}</span>
      {k === 'format' ? (
        <Select value={draft.format} onChange={e => setDraft(d => ({ ...d, format: e.target.value }))}
          className="min-w-0 flex-1">
          {isDefault
            ? <option value="">openai</option>
            : <option value=""></option>}
          {formats.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </Select>
      ) : k === 'apiKey' ? (
          <div className="relative min-w-0 flex-1">
            <Input type={peek ? 'text' : 'password'} value={peek ? peekVal : draft.apiKey} readOnly={peek} placeholder={ph}
              onChange={e => setDraft(d => ({ ...d, apiKey: e.target.value }))}
              className="w-full pr-8 font-mono text-[13px]" />
            <button type="button" onClick={() => void togglePeek()} aria-label={peek ? '隐藏明文' : '查看明文'}
              title={peek ? '隐藏明文' : '查看明文(操作会留审计日志)'}
              className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-tertiary hover:bg-surface-2 hover:text-primary">
              {peek ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
        ) : (
          <Input type={type} value={draft[k]} placeholder={ph} onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))}
            className="min-w-0 flex-1 font-mono text-[13px]" />
      )}
    </label>
  );

  return (
    <div className="px-1 pb-1">  {/* 单框: 内框删(外层分组卡承担) */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-secondary">
          {isDefault ? '默认大模型供应商' : '本 agent 覆盖'}
          {!isDefault && overridden && <Badge tone="accent">已覆盖</Badge>}
        </span>
        <Button onClick={() => void save()} disabled={!dirty || state === 'saving'} variant="primary" size="sm">
          {state === 'saving' ? '保存中…' : state === 'ok' ? '✓ 已保存' : '保存'}
        </Button>
      </div>
      <div className="space-y-1.5">
        {field('format', '接口格式', '')}
        {/* R32D45-N3/CS19-4: 适配说明按选中格式从 schema 下发的
            单源数据渲染。 */}
        {field('baseUrl', 'Base URL', isDefault ? 'https://open.bigmodel.cn/api/paas/v4' : '')}
        {field('apiKey', 'API Key', '', 'password')}
        {field('model', '模型名称', isDefault ? 'glm-4.7' : '')}
      </div>
      {state === 'err' && <p className="mt-1.5 truncate text-xs text-danger-text" title={msg}>{msg}</p>}
    </div>
  );
}
