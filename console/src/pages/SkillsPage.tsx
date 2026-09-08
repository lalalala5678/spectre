import { useState } from 'react';
import { FileUp, FolderInput, Globe, Plus, Search, Trash2 } from 'lucide-react';
import { AGENT_LABEL, SKILLS } from '../mock/data';
import { Dot, riskTone } from '../components/ui/Badge';
import { Panel } from '../components/ui/Panel';
import { Toggle } from '../components/ui/Toggle';
import { cn } from '../utils/cn';

const SOURCE_LABEL = { builtin: '内置', registry: '注册中心', local: '本地导入' } as const;

/** Skill 管理页：列表 + 导入向导（本地/注册中心） */
export function SkillsPage() {
  const [skills, setSkills] = useState(SKILLS);
  const [filter, setFilter] = useState('');

  const list = skills.filter(
    (s) => s.name.includes(filter) || s.desc.includes(filter),
  );

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
      {/* 列表 */}
      <Panel
        title="已安装 Skills"
        right={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-600" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="过滤…"
                className="w-36 rounded-sm border border-void-600 bg-void-900 py-1 pl-7 pr-2 text-[11px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-void-500"
              />
            </div>
            <button className="flex items-center gap-1 rounded-sm bg-orange-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-orange-500">
              <Plus className="h-3 w-3" /> 导入 Skill
            </button>
          </div>
        }
        className="xl:col-span-2"
        bodyClassName="p-0"
      >
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-void-700 text-[10px] uppercase tracking-wider text-zinc-600">
              <th className="px-3 py-2 font-semibold">Skill</th>
              <th className="px-3 py-2 font-semibold">风险级</th>
              <th className="px-3 py-2 font-semibold">来源</th>
              <th className="px-3 py-2 font-semibold">挂载 Agent</th>
              <th className="px-3 py-2 font-semibold">启用</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-void-700">
            {list.map((s) => (
              <tr key={s.id} className="hover:bg-void-800/60">
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] font-medium text-zinc-200">{s.name}</span>
                    <span className="font-mono text-[10px] text-zinc-600">v{s.version}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-zinc-500">{s.desc}</div>
                  <div className="mt-0.5 font-mono text-[10px] text-zinc-600">{s.entry}</div>
                </td>
                <td className="px-3 py-2.5">
                  <span className={cn('flex items-center gap-1.5 text-[11px]',
                    s.risk === 'safe' ? 'text-zinc-500' : '')}>
                    <Dot tone={riskTone(s.risk)} />
                    <span className={s.risk === 'safe' ? 'text-zinc-500' : s.risk === 'intrusive' ? 'text-amber-400/80' : 'text-red-400/90'}>{s.risk}</span>
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <span className="text-[11px] text-zinc-500">{SOURCE_LABEL[s.source]}</span>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {s.boundAgents.map((a) => (
                      <span key={a} className="rounded-sm bg-void-700 px-1.5 py-0.5 text-[10px] text-zinc-400">
                        {AGENT_LABEL[a]}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <Toggle
                    checked={s.enabled}
                    onChange={(v) =>
                      setSkills(skills.map((x) => (x.id === s.id ? { ...x, enabled: v } : x)))
                    }
                  />
                </td>
                <td className="px-3 py-2.5 text-right">
                  {s.source !== 'builtin' && (
                    <button className="rounded-sm p-1 text-zinc-600 hover:bg-red-950/50 hover:text-red-400">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {/* 导入向导 */}
      <div className="space-y-3">
        <Panel title="导入 Skill">
          <div className="space-y-2">
            <button className="flex w-full items-center gap-3 rounded-sm border border-void-600 bg-void-900 p-3 text-left hover:border-void-500">
              <FolderInput className="h-4.5 w-4.5 text-zinc-500" />
              <div>
                <div className="text-[12.5px] font-medium text-zinc-200">本地目录 / zip 包</div>
                <div className="text-[10.5px] text-zinc-600">含 SKILL.md 的目录，签名校验后挂载</div>
              </div>
            </button>
            <button className="flex w-full items-center gap-3 rounded-sm border border-void-600 bg-void-900 p-3 text-left hover:border-void-500">
              <Globe className="h-4.5 w-4.5 text-zinc-500" />
              <div>
                <div className="text-[12.5px] font-medium text-zinc-200">Skill 注册中心</div>
                <div className="text-[10.5px] text-zinc-600">浏览内部 registry，按风险级/评分筛选</div>
              </div>
            </button>
            <button className="flex w-full items-center gap-3 rounded-sm border border-void-600 bg-void-900 p-3 text-left hover:border-void-500">
              <FileUp className="h-4.5 w-4.5 text-zinc-500" />
              <div>
                <div className="text-[12.5px] font-medium text-zinc-200">粘贴 SKILL.md 原文</div>
                <div className="text-[10.5px] text-zinc-600">快速单文件导入，自动解析参数声明</div>
              </div>
            </button>
          </div>
        </Panel>

        <Panel title="风险级说明">
          <div className="space-y-2 text-[11.5px] leading-relaxed text-zinc-500">
            {([
              ['safe', '被动/只读，不触达目标', 'slate'],
              ['intrusive', '主动发包，受速率约束', 'amber'],
              ['exploit', '利用级动作，默认需审批', 'red'],
              ['credential', '涉及凭据/密钥处理', 'red'],
            ] as [string, string, 'slate' | 'amber' | 'red'][]).map(([r, d, t]) => (
              <div key={r} className="flex items-center gap-2">
                <Dot tone={t} />
                <span className="font-mono text-zinc-400">{r}</span>
                <span>{d}</span>
              </div>
            ))}
            <p className="border-t border-void-700 pt-2 text-[10.5px] text-zinc-600">
              exploit 及以上风险级的 Skill 启用时，会强制要求审批策略 ≥ exploit+，并记录完整审计链。
            </p>
          </div>
        </Panel>

        <Panel title="Registry 同步">
          <div className="font-mono text-[11px] text-zinc-600">
            registry.internal/skills · 上次同步 06:00<br />312 可用 · 9 已安装
          </div>
        </Panel>
      </div>
    </div>
  );
}
