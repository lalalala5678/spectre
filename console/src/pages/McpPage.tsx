import { useEffect, useState } from 'react';
import { Globe, PlugZap, Plus, Terminal, Trash2 } from 'lucide-react';

import { api } from '../api/client';
import { ToolingChat } from '../components/ToolingChat';
import { Panel } from '../components/ui/Panel';
import { cn } from '../utils/cn';

const AGENTS = ['autopwn', 'recon', 'nday', 'weakcred', 'api', 'exploit',
  'phish', 'c2', 'persistence', 'postex', 'report'];

interface McpServer {
  name: string;
  transport: 'stdio' | 'http';
  agents: string[];
  enabled: boolean;
  url?: string;
  command?: string[];
  where?: 'sandbox' | 'host';
}

/** MCP Server 管理页 — 双传输：远程 HTTP（用户自建机器直连）与本地
 *  stdio（宿主或沙箱内进程）。按 agent 挂载；工具在会话创建时合并。 */
export function McpPage({ wsId }: { wsId: string }) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [form, setForm] = useState({
    name: '', transport: 'http' as 'http' | 'stdio',
    url: '', headersJson: '', commandStr: '',
    where: 'host' as 'host' | 'sandbox', agents: ['recon'] as string[],
  });
  const [testing, setTesting] = useState('');
  const [results, setResults] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');

  const load = async () => {
    try { setServers(await api<McpServer[]>('/sandbox/mcp')); }
    catch (e) { setMsg(String(e)); }
  };
  useEffect(() => { void load(); }, []);

  const toggleAgent = (a: string) => {
    setForm(f => ({ ...f,
      agents: f.agents.includes(a)
        ? f.agents.filter(x => x !== a) : [...f.agents, a] }));
  };

  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (busy) return;
    if (!form.name.trim()) { setMsg('name 必填'); return; }
    let headers: Record<string, string> = {};
    if (form.transport === 'http') {
      try {
        headers = JSON.parse(form.headersJson || '{}');
        // R11-F3: JSON.parse 只验'是 JSON'——'x'/[1]/5 标量数组穿透
        // 到后端持久化(R5-F3 未覆盖 headers 类型)。
        const parsed: unknown = JSON.parse(form.headersJson || '{}');
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setMsg('headers 必须为 {"k":"v"} JSON 对象');
          return;
        }
        headers = parsed as Record<string, string>;
      } catch { setMsg('headers 非法 JSON'); return; }
    }
    const body = form.transport === 'http'
      ? { name: form.name, transport: 'http', url: form.url,
          headers, agents: form.agents }
      : { name: form.name, transport: 'stdio',
          command: form.commandStr.trim().split(/\s+/).filter(Boolean),
          where: form.where, agents: form.agents };
    setBusy(true);
    try {
      await api('/sandbox/mcp', { method: 'POST', json: body });
      setMsg(`已注册 ${form.name}`);
      // R11-F2: 对齐 SkillsPage——成功后清载荷字段(保留挂载目标)
      setForm(f => ({ ...f, name: '', url: '', headersJson: '', commandStr: '' }));
      await load();
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };

  const test = async (name: string) => {
    setTesting(name);
    setResults(r => ({ ...r, [name]: '…' }));
    try {
      const res = await api<{ ok: boolean; serverName?: string;
        tools?: string[]; error?: string }>('/sandbox/mcp/test',
        { method: 'POST', json: { name } });
      setResults(r => ({ ...r, [name]: res.ok
        ? `✓ ${res.serverName} — 工具: ${(res.tools ?? []).join(', ') || '无'}`
        : `✗ ${res.error}` }));
    } catch (e) { setResults(r => ({ ...r, [name]: `✗ ${String(e)}` })); }
    finally { setTesting(''); }
  };

  const remove = async (name: string) => {
    if (!window.confirm(`注销 MCP server ${name}（对新会话生效，后台连接将关闭）？`)) return;
    try {
      await api(`/sandbox/mcp?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      setMsg(`已注销 ${name}`);
      await load();
    } catch (e) { setMsg(String(e)); }
  };

  return (
    <div className="grid h-full grid-cols-1 gap-3 xl:grid-cols-3">
      <Panel title="已注册 MCP Servers" className="min-h-0 xl:col-span-2" bodyClassName="p-0">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-void-700 text-[10px] uppercase tracking-wider text-zinc-600">
              <th className="px-3 py-2 font-semibold">名称</th>
              <th className="px-3 py-2 font-semibold">传输</th>
              <th className="px-3 py-2 font-semibold">挂载 Agent</th>
              <th className="px-3 py-2 font-semibold">连接</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-void-700">
            {servers.map(s => (
              <tr key={s.name} className="hover:bg-void-800/60">
                <td className="px-3 py-2.5">
                  <div className="font-mono text-[12px] text-zinc-200">{s.name}</div>
                  <div className="mt-0.5 flex items-center gap-1 font-mono text-[10px] text-zinc-600">
                    {s.transport === 'http'
                      ? <><Globe className="h-3 w-3" />{s.url}</>
                      : <><Terminal className="h-3 w-3" />{(s.command ?? []).join(' ')} @{s.where}</>}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <span className={cn('rounded-sm px-1.5 py-0.5 font-mono text-[10px]',
                    s.transport === 'http' ? 'bg-sky-950/60 text-sky-300' : 'bg-void-700 text-zinc-400')}>
                    {s.transport}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {(s.agents ?? []).map(a => (
                      <span key={a} className="rounded-sm bg-void-700 px-1.5 py-0.5 font-mono text-[10px] text-orange-300/90">{a}</span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <button
                    onClick={() => void test(s.name)}
                    disabled={testing === s.name}
                    className="flex items-center gap-1 rounded-sm border border-void-600 px-2 py-1 text-[10px] text-zinc-300 hover:border-void-400 disabled:opacity-50"
                  >
                    <PlugZap className="h-3 w-3" /> {testing === s.name ? '测试中' : '连通测试'}
                  </button>
                  {results[s.name] && (
                    <div className={cn('mt-1 font-mono text-[9.5px]',
                      results[s.name].startsWith('✓') ? 'text-emerald-400' : 'text-red-400')}>
                      {results[s.name]}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <button
                    onClick={() => void remove(s.name)}
                    className="rounded-sm p-1 text-zinc-600 hover:bg-void-700 hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
            {servers.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-8 text-center text-[11px] text-zinc-600">
                暂无注册 — 远程 server 填 URL 直连；本地 server 填启动命令
              </td></tr>
            )}
          </tbody>
        </table>
      </Panel>

      <div className="flex min-h-0 flex-col gap-3">
      <Panel title="注册新 Server" bodyClassName="p-3 space-y-2">
        <input
          value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
          placeholder="名称（如 shodan）"
          className="w-full rounded-sm border border-void-600 bg-void-900 px-2 py-1.5 text-[12px] text-zinc-200 placeholder:text-zinc-600"
        />
        <div className="flex gap-2">
          {(['http', 'stdio'] as const).map(t => (
            <button key={t} onClick={() => setForm({ ...form, transport: t })}
              className={cn('flex-1 rounded-sm border px-2 py-1 font-mono text-[11px]',
                form.transport === t ? 'border-orange-600 bg-orange-950/30 text-orange-300' : 'border-void-600 text-zinc-500')}>
              {t === 'http' ? '远程 HTTP' : '本地 stdio'}
            </button>
          ))}
        </div>
        {form.transport === 'http' ? (
          <>
            <input
              value={form.url} onChange={e => setForm({ ...form, url: e.target.value })}
              placeholder="https://your-host/mcp（用户自建机器）"
              className="w-full rounded-sm border border-void-600 bg-void-900 px-2 py-1.5 text-[12px] text-zinc-200 placeholder:text-zinc-600"
            />
            <textarea
              value={form.headersJson} onChange={e => setForm({ ...form, headersJson: e.target.value })}
              rows={2} placeholder='{"Authorization":"Bearer …"}'
              className="w-full rounded-sm border border-void-600 bg-void-900 px-2 py-1.5 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600"
            />
          </>
        ) : (
          <>
            <input
              value={form.commandStr} onChange={e => setForm({ ...form, commandStr: e.target.value })}
              placeholder="启动命令（如 node /opt/mcp-shodan.mjs）"
              className="w-full rounded-sm border border-void-600 bg-void-900 px-2 py-1.5 text-[12px] text-zinc-200 placeholder:text-zinc-600"
            />
            <div className="flex gap-2">
              {(['host', 'sandbox'] as const).map(w => (
                <button key={w} onClick={() => setForm({ ...form, where: w })}
                  className={cn('flex-1 rounded-sm border px-2 py-1 font-mono text-[10px]',
                    form.where === w ? 'border-orange-600 bg-orange-950/30 text-orange-300' : 'border-void-600 text-zinc-500')}>
                  {w === 'host' ? '宿主进程' : '沙箱内进程'}
                </button>
              ))}
            </div>
          </>
        )}
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-600">挂载 Agent</p>
          <div className="flex flex-wrap gap-1">
            {AGENTS.map(a => (
              <button key={a} onClick={() => toggleAgent(a)}
                className={cn('rounded-sm px-1.5 py-0.5 font-mono text-[10px]',
                  form.agents.includes(a) ? 'bg-orange-950/60 text-orange-300 border border-orange-800' : 'bg-void-800 text-zinc-500 border border-void-700')}>
                {a}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={() => void create()}
            disabled={busy}
          className="flex w-full items-center justify-center gap-1 rounded-sm bg-orange-600 px-2 py-1.5 text-[11px] font-medium text-white hover:bg-orange-500"
        >
          <Plus className="h-3 w-3" /> 注册并挂载
        </button>
        {msg && <p className="font-mono text-[10.5px] text-amber-400">{msg}</p>}
      </Panel>
      <ToolingChat agentKey="mcp-config" workSessionId={wsId} />
      </div>
    </div>
  );
}
