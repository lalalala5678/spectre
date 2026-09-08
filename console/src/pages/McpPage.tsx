import { useState } from 'react';
import { Plus } from 'lucide-react';
import { AGENT_LABEL, MCP_SERVERS } from '../mock/data';
import { Dot } from '../components/ui/Badge';
import { Panel } from '../components/ui/Panel';
import { cn } from '../utils/cn';

/** MCP Server 管理页：连接状态 + 工具清单 + 挂载矩阵 */
export function McpPage() {
  const [selected, setSelected] = useState(MCP_SERVERS[0].id);
  const sel = MCP_SERVERS.find((m) => m.id === selected)!;

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
      {/* server 列表 */}
      <Panel
        title="MCP Servers"
        right={
          <button className="flex items-center gap-1 rounded-sm bg-orange-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-orange-500">
            <Plus className="h-3 w-3" /> 接入 Server
          </button>
        }
        bodyClassName="p-0"
      >
        <div className="divide-y divide-void-700">
          {MCP_SERVERS.map((m) => (
            <button
              key={m.id}
              onClick={() => setSelected(m.id)}
              className={cn(
                'flex w-full items-center gap-3 px-3 py-2.5 text-left',
                selected === m.id ? 'bg-void-800' : 'hover:bg-void-800/60',
              )}
            >
              <Dot tone={m.status === 'connected' ? 'green' : m.status === 'error' ? 'red' : 'slate'} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[12px] font-medium text-zinc-200">{m.name}</span>
                  <span className="font-mono text-[9.5px] text-zinc-600">{m.transport}</span>
                </div>
                <div className="truncate text-[10.5px] text-zinc-600">{m.desc}</div>
              </div>
              <span className={cn('text-[10px]',
                m.status === 'connected' ? 'text-zinc-500' : m.status === 'error' ? 'text-red-400' : 'text-zinc-600')}>
                {m.status}
              </span>
            </button>
          ))}
        </div>
      </Panel>

      {/* 详情 */}
      <Panel title={`Server 详情 · ${sel.name}`} className="xl:col-span-2">
        <div className="space-y-4">
          {/* 连接信息 */}
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <div className="rounded-sm border border-void-700 bg-void-900 p-2.5">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Endpoint / Command</div>
              <code className="font-mono text-[11.5px] text-zinc-300">{sel.endpoint}</code>
            </div>
            <div className="rounded-sm border border-void-700 bg-void-900 p-2.5">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Env Keys（值存于密钥库，不落盘）</div>
              {sel.envKeys.length ? (
                <div className="flex gap-1.5">
                  {sel.envKeys.map((k) => (
                    <code key={k} className="rounded-sm bg-void-950 px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-400">{k}=••••••</code>
                  ))}
                </div>
              ) : (
                <span className="text-[11px] text-zinc-600">无需凭证</span>
              )}
            </div>
          </div>

          {/* 工具清单 */}
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">暴露工具（{sel.tools.length}）</div>
            <div className="space-y-1">
              {sel.tools.map((t) => (
                <div key={t.name} className="flex items-center gap-3 rounded-sm border border-void-700 bg-void-900 px-2.5 py-2">
                  <code className="font-mono text-[11.5px] text-zinc-200">{t.name}</code>
                  <span className="text-[11px] text-zinc-600">{t.desc}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 挂载矩阵 */}
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">挂载到 Agent</div>
            <div className="flex flex-wrap gap-1">
              {Object.entries(AGENT_LABEL).map(([id, label]) => {
                const bound = sel.boundAgents.includes(id as never);
                return (
                  <button
                    key={id}
                    className={cn(
                      'rounded-sm border px-2 py-1 text-[11px] transition-colors',
                      bound
                        ? 'border-orange-700 bg-orange-950/30 text-orange-300'
                        : 'border-void-600 bg-void-900 text-zinc-600 hover:text-zinc-400',
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex gap-2 border-t border-void-700 pt-3">
            <button className="rounded-sm border border-void-600 bg-void-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-void-700">
              测试连接
            </button>
            <button className="rounded-sm border border-void-600 bg-void-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-void-700">
              重新发现工具
            </button>
            <button className="ml-auto rounded-sm border border-red-900 bg-red-950/40 px-3 py-1.5 text-xs text-red-400 hover:bg-red-950">
              断开并移除
            </button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
