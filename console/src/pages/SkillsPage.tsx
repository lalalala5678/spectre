import { useEffect, useState } from 'react';
import { FileCode2, Plus, Search, Trash2 } from 'lucide-react';

import { api } from '../api/client';
import { ToolingChat } from '../components/ToolingChat';
import { Panel } from '../components/ui/Panel';
import { cn } from '../utils/cn';

const AGENTS = ['autopwn', 'recon', 'nday', 'weakcred', 'api', 'exploit',
  'phish', 'c2', 'persistence', 'postex', 'report'];

interface SkillRow {
  agentKey: string;
  name: string;
  description: string;
  filePath: string;
}

/** Skill 管理页 — per-agent 挂载（目录即仓库，SKILL.md 官方格式；
 *  会话创建时官方索引注入，模型按需 read 全文）。 */
export function SkillsPage({ wsId }: { wsId: string }) {
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
    if (!window.confirm(`卸载技能 ${name}（从 ${agentKey}，对其新会话生效）？`)) return;
    try {
      await api(`/sandbox/skills?agentKey=${agentKey}&name=${encodeURIComponent(name)}`,
        { method: 'DELETE' });
      setMsg(`已卸载 ${agentKey}/${name}`);
      await load();
    } catch (e) { setMsg(String(e)); }
  };

  return (
    <div className="grid h-full grid-cols-1 gap-3 xl:grid-cols-3">
      <Panel
        title="已挂载 Skills（按 Agent）"
        right={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-600" />
              <input
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="过滤…"
                className="w-36 rounded-sm border border-void-600 bg-void-900 py-1 pl-7 pr-2 text-[11px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-void-500"
              />
            </div>
            <button
              onClick={() => setCreating(v => !v)}
              className="flex items-center gap-1 rounded-sm bg-orange-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-orange-500"
            >
              <Plus className="h-3 w-3" /> {creating ? '收起' : '导入 Skill'}
            </button>
          </div>
        }
        className="min-h-0 xl:col-span-2"
        bodyClassName="p-0"
      >
        {creating && (
          <div className="space-y-2 border-b border-void-700 p-3">
            <div className="flex gap-2">
              <select
                value={form.agentKey}
                onChange={e => setForm({ ...form, agentKey: e.target.value })}
                className="rounded-sm border border-void-600 bg-void-900 px-2 py-1.5 text-[12px] text-zinc-200"
              >
                {AGENTS.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              <input
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="skill 名（如 subdomain-sweep）"
                className="flex-1 rounded-sm border border-void-600 bg-void-900 px-2 py-1.5 text-[12px] text-zinc-200 placeholder:text-zinc-600"
              />
              <input
                value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                placeholder="触发条件一句话（进索引）"
                className="flex-1 rounded-sm border border-void-600 bg-void-900 px-2 py-1.5 text-[12px] text-zinc-200 placeholder:text-zinc-600"
              />
            </div>
            <textarea
              value={form.content}
              onChange={e => setForm({ ...form, content: e.target.value })}
              rows={6}
              placeholder="技能全文 markdown（SKILL.md 正文；模型按需读取）"
              className="w-full rounded-sm border border-void-600 bg-void-900 px-2 py-1.5 font-mono text-[12px] text-zinc-200 placeholder:text-zinc-600"
            />
            <button
              onClick={() => void create()}
              disabled={busy}
              className="rounded-sm bg-orange-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-orange-500 disabled:opacity-50"
            >
              {busy ? '保存中…' : '保存并挂载'}
            </button>
          </div>
        )}
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-void-700 text-[10px] uppercase tracking-wider text-zinc-600">
              <th className="px-3 py-2 font-semibold">Skill</th>
              <th className="px-3 py-2 font-semibold">挂载 Agent</th>
              <th className="px-3 py-2 font-semibold">文件</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-void-700">
            {list.map(s => (
              <tr key={`${s.agentKey}/${s.name}`} className="hover:bg-void-800/60">
                <td className="px-3 py-2.5">
                  <div className="font-mono text-[12px] font-medium text-zinc-200">{s.name}</div>
                  <div className="mt-0.5 text-[11px] text-zinc-500">{s.description}</div>
                </td>
                <td className="px-3 py-2.5">
                  <span className="rounded-sm bg-void-700 px-1.5 py-0.5 font-mono text-[10px] text-orange-300/90">
                    {s.agentKey}
                  </span>
                </td>
                <td className="px-3 py-2.5 font-mono text-[10px] text-zinc-600">{s.filePath}</td>
                <td className="px-3 py-2.5 text-right">
                  <button
                    onClick={() => void remove(s.agentKey, s.name)}
                    className="rounded-sm p-1 text-zinc-600 hover:bg-void-700 hover:text-red-400"
                    title="卸载"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-8 text-center text-[11px] text-zinc-600">
                暂无挂载 — 每个 agent 只加载属于自己的技能（防止工具面污染）
              </td></tr>
            )}
          </tbody>
        </table>
      </Panel>

      <div className="flex min-h-0 flex-col gap-3">
      <Panel title="机制说明" bodyClassName="p-3 space-y-2 text-[11.5px] leading-relaxed text-zinc-400">
        <p className="flex items-start gap-1.5"><FileCode2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-400/80" />
          存储为 agentskills.io 官方格式（SKILL.md + frontmatter），由 pi 官方加载器解析。</p>
        <p><span className="text-zinc-200">按需加载：</span>会话创建时仅注入索引（名称+触发条件），模型判断匹配后自行 read 全文——不撑爆上下文。</p>
        <p><span className="text-zinc-200">角色挂载：</span>每个 agent 只看到挂给自己的技能目录。</p>
        {msg && <p className={cn('font-mono text-[10.5px]', msg.includes('已') ? 'text-emerald-400' : 'text-amber-400')}>{msg}</p>}
      </Panel>
      <ToolingChat agentKey="skill-config" workSessionId={wsId} />
      </div>
    </div>
  );
}
