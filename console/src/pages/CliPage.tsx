import { useState } from 'react';
import { Container, FolderInput, Plus, RefreshCw, TerminalSquare, Upload } from 'lucide-react';
import { AGENT_LABEL, CLI_TOOLS } from '../mock/data';
import { Dot } from '../components/ui/Badge';
import { Panel } from '../components/ui/Panel';

const SOURCE_LABEL = { builtin: '内置', local: '本地导入', docker: 'Docker 镜像' } as const;

/** CLI 工具导入页：二进制/容器工具的注册、包装与挂载 */
export function CliPage() {
  const [tools, setTools] = useState(CLI_TOOLS);

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
      {/* 工具列表 */}
      <Panel
        title="已注册 CLI 工具"
        right={
          <button className="flex items-center gap-1 rounded-sm bg-orange-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-orange-500">
            <Plus className="h-3 w-3" /> 导入工具
          </button>
        }
        className="xl:col-span-2"
        bodyClassName="p-0"
      >
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-void-700 text-[10px] uppercase tracking-wider text-zinc-600">
              <th className="px-3 py-2 font-semibold">工具</th>
              <th className="px-3 py-2 font-semibold">路径 / 镜像</th>
              <th className="px-3 py-2 font-semibold">来源</th>
              <th className="px-3 py-2 font-semibold">包装 Skill</th>
              <th className="px-3 py-2 font-semibold">挂载 Agent</th>
              <th className="px-3 py-2 font-semibold">状态</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-void-700">
            {tools.map((t) => (
              <tr key={t.id} className="hover:bg-void-800/60">
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                    <span className="font-mono text-[12px] font-medium text-zinc-200">{t.name}</span>
                    <span className="font-mono text-[10px] text-zinc-600">{t.version}</span>
                  </div>
                  <div className="mt-0.5 pl-5.5 text-[11px] text-zinc-500">{t.desc}</div>
                </td>
                <td className="px-3 py-2.5">
                  <code className="font-mono text-[10.5px] text-zinc-400">{t.binary}</code>
                </td>
                <td className="px-3 py-2.5">
                  <span className="flex items-center gap-1 text-[11px] text-zinc-500">
                    {t.source === 'docker' && <Container className="h-3 w-3" />}
                    {SOURCE_LABEL[t.source]}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  {t.wrapperSkill
                    ? <span className="font-mono text-[10.5px] text-zinc-300">#{t.wrapperSkill}</span>
                    : <span className="text-[10px] text-zinc-700">未包装</span>}
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {t.boundAgents.map((a) => (
                      <span key={a} className="rounded-sm bg-void-700 px-1.5 py-0.5 text-[10px] text-zinc-400">
                        {AGENT_LABEL[a]}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <button
                    onClick={() => setTools(tools.map((x) => (x.id === t.id ? { ...x, installed: !x.installed } : x)))}
                    className="flex items-center gap-1.5 text-[11px]"
                  >
                    <Dot tone={t.installed ? 'cyan' : 'slate'} />
                    <span className={t.installed ? 'text-zinc-400' : 'text-zinc-600'}>
                      {t.installed ? '可用' : '未安装'}
                    </span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {/* 导入方式 */}
      <div className="space-y-3">
        <Panel title="导入 CLI 工具">
          <div className="space-y-2">
            <button className="flex w-full items-center gap-3 rounded-sm border border-void-600 bg-void-900 p-3 text-left hover:border-void-500">
              <Upload className="h-4.5 w-4.5 text-zinc-500" />
              <div>
                <div className="text-[12.5px] font-medium text-zinc-200">上传二进制</div>
                <div className="text-[10.5px] text-zinc-600">静态编译单文件，校验 SHA-256 后入库</div>
              </div>
            </button>
            <button className="flex w-full items-center gap-3 rounded-sm border border-void-600 bg-void-900 p-3 text-left hover:border-void-500">
              <FolderInput className="h-4.5 w-4.5 text-zinc-500" />
              <div>
                <div className="text-[12.5px] font-medium text-zinc-200">挂载主机路径</div>
                <div className="text-[10.5px] text-zinc-600">引用 worker 节点上已有工具（如 /opt/tools）</div>
              </div>
            </button>
            <button className="flex w-full items-center gap-3 rounded-sm border border-void-600 bg-void-900 p-3 text-left hover:border-void-500">
              <Container className="h-4.5 w-4.5 text-zinc-500" />
              <div>
                <div className="text-[12.5px] font-medium text-zinc-200">Docker 镜像</div>
                <div className="text-[10.5px] text-zinc-600">容器隔离运行，输出回收后销毁实例</div>
              </div>
            </button>
          </div>
        </Panel>

        <Panel title="包装机制">
          <p className="text-[11.5px] leading-relaxed text-zinc-500">
            Agent 不直接执行裸二进制。CLI 工具导入后需包装为 Skill（声明参数、超时、速率、输出解析），
            由 Skill 层统一施加约束与审计。未包装的工具对 agent 不可见。
          </p>
        </Panel>

        <Panel title="工具源同步" right={<RefreshCw className="h-3.5 w-3.5 text-zinc-600" />}>
          <div className="font-mono text-[11px] text-zinc-600">
            内置源 projectdiscovery 系 · 每日 04:00 检查更新<br />8 已注册 · 7 可用
          </div>
        </Panel>
      </div>
    </div>
  );
}
