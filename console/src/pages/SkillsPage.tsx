import { useEffect, useState } from 'react';
import { FileCode2, PackageOpen, Plus, Search, Trash2 } from 'lucide-react';

import { api } from '../api/client';
import { ToolingChat } from '../components/ToolingChat';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { Input, Select, Textarea } from '../components/ui/Input';
import { Panel } from '../components/ui/Panel';
import { SplitPane } from '../components/ui/SplitPane';
import { cn } from '../utils/cn';
import { AGENTS as REGISTRY } from '../api/agentRegistry';
import { usePageTitle } from '../utils/usePageTitle';

// CS2-#6: 挂载目标单源 agentRegistry 派生(与 McpPage 同式; 过滤配置
// 三键, 语义=业务面)。CRUD 外壳刻意不抽象为通用 hook——四页差异面
// 远大于共性, 见 CS1-R19 决策。
const CONFIG_AGENT_KEYS = ['skill-config', 'mcp-config', 'cli-config'];
const AGENTS = REGISTRY.map(a => a.id).filter(id => !CONFIG_AGENT_KEYS.includes(id));

interface SkillRow {
  agentKey: string;
  name: string;
  description: string;
  filePath: string;
}

/** Skill 管理页 — per-agent 挂载（目录即仓库，SKILL.md 官方格式；
 *  会话创建时官方索引注入，模型按需 read 全文）。 */

export function SkillsPage({ wsId }: { wsId: string }) {
  const [arm, setArm] = useState<string | null>(null);
  usePageTitle('技能管理'); // FEVERIFY-N3
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ agentKey: 'recon', name: '',
    description: '', content: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = async () => {
    try {
      setSkills(await api<SkillRow[]>('/sandbox/skills'));
    } catch (e) { setMsg(String(e)); }
  };
  useEffect(() => { void load(); }, []);

  const list = skills.filter(s => s.name.includes(filter)
    || s.agentKey.includes(filter) || s.description.includes(filter));

  const create = async () => {
    if (!form.name.trim() || !form.content.trim()) {
      setMsg('name 与 content 必填');
      return;
    }
    setBusy(true);
    try {
      await api('/sandbox/skills', { method: 'POST', json: form });
      setMsg(`已挂载到 ${form.agentKey}`);
      setCreating(false);
      setForm({ agentKey: form.agentKey, name: '', description: '', content: '' });
      await load();
    } catch (e) { setMsg(String(e)); } finally { setBusy(false); }
  };

  const remove = async (agentKey: string, name: string) => {
    // r50e: 两击确认(禁原生弹窗)
    try {
      await api(`/sandbox/skills?agentKey=${encodeURIComponent(agentKey)}&name=${encodeURIComponent(name)}`,  // CS67-6: 两参同编码
        { method: 'DELETE' });
      setMsg(`已卸载 ${agentKey}/${name}`);
      await load();
    } catch (e) { setMsg(String(e)); }
  };

  return (
    <SplitPane storageKey="spectre.split.skills-v4" initial={0.5}>
      <div className="flex min-h-0 min-w-0 flex-col gap-3">

      <Panel title="机制说明" className="shrink-0" bodyClassName="space-y-2 text-[13px] leading-relaxed text-secondary">
        <p className="flex items-start gap-1.5"><FileCode2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-tertiary" />
          存储为 agentskills.io 官方格式（SKILL.md + frontmatter），由 pi 官方加载器解析。</p>
        <p><span className="font-medium text-primary">按需加载：</span>会话创建时仅注入索引（名称+触发条件），模型判断匹配后自行 read 全文——不撑爆上下文。</p>
        <p><span className="font-medium text-primary">角色挂载：</span>每个 agent 只看到挂给自己的技能目录。</p>
        {msg && <p className={cn('text-[13px]', msg.includes('已') ? 'text-success-text' : 'text-danger-text')}>{msg}</p>}
      </Panel>
      <div className="flex min-h-0 flex-1 flex-col"><ToolingChat agentKey="skill-config" workSessionId={wsId} /></div>
      </div>

      <Panel
        title="已挂载 Skills（按 Agent）"
        right={
          <div className="flex items-center gap-2">
            <div className="relative w-48">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
              <Input
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="过滤…"
                className="pl-8"
              />
            </div>
            <Button variant="primary" size="sm" onClick={() => setCreating(v => !v)}>
              <Plus className="h-3.5 w-3.5" /> {creating ? '收起' : '导入 Skill'}
            </Button>
          </div>
        }
        className="h-full min-h-0"
        bodyClassName="flex min-h-0 flex-col p-0"
      >
        {creating && (
          <div className="m-4 shrink-0 space-y-3 rounded-lg border border-line bg-surface-2 p-4">
            <div className="flex gap-2">
              <Select
                value={form.agentKey}
                onChange={e => setForm({ ...form, agentKey: e.target.value })}
                className="w-36"
              >
                {AGENTS.map(a => <option key={a} value={a}>{a}</option>)}
              </Select>
              <Input
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="skill 名（如 subdomain-sweep）"
                className="flex-1"
              />
              <Input
                value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                placeholder="触发条件一句话（进索引）"
                className="flex-1"
              />
            </div>
            <Textarea
              value={form.content}
              onChange={e => setForm({ ...form, content: e.target.value })}
              rows={6}
              placeholder="技能全文 markdown（SKILL.md 正文；模型按需读取）"
              className="font-mono text-[13px]"
            />
            <Button variant="primary" size="sm" onClick={() => void create()} disabled={busy} className="min-w-20">
              {busy ? '保存中…' : '保存并挂载'}
            </Button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto"><table className="w-full text-left">
          <thead>
            <tr className="text-xs font-medium text-tertiary">
              <th className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2 text-left font-medium">Skill</th>
              <th className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2 text-left font-medium">挂载 Agent</th>
              <th className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2 text-left font-medium">文件</th>
              <th className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.map(s => (
              <tr key={`${s.agentKey}/${s.name}`} className="odd:bg-surface-2/50 hover:bg-surface-2">
                <td className="px-3 py-2.5">
                  <div className="font-mono text-[13px] font-medium text-primary">{s.name}</div>
                  <div className="mt-0.5 text-[13px] text-secondary">{s.description}</div>
                </td>
                <td className="px-3 py-2.5">
                  <Badge tone="accent">{s.agentKey}</Badge>
                </td>
                <td className="px-3 py-2.5 font-mono text-xs text-tertiary">{s.filePath}</td>
                <td className="px-3 py-2.5 text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => { if (arm !== s.name) { setArm(s.name); setTimeout(() => setArm(a => a === s.name ? null : a), 2500); return; } setArm(null); void remove(s.agentKey, s.name); }}
                    title="卸载"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={4} className="p-0">
                  <EmptyState
                    icon={PackageOpen}
                    title="暂无挂载 Skill"
                    hint="每个 agent 只加载属于自己的技能（防止工具面污染）——上方「导入 Skill」创建"
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table></div>
      </Panel>
    </SplitPane>
  );
}
