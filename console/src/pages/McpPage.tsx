import { useEffect, useState } from 'react';
import { Globe, PlugZap, Plus, Terminal, Trash2 } from 'lucide-react';

import { api } from '../api/client';
import { ToolingChat } from '../components/ToolingChat';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { Input, Label, Textarea } from '../components/ui/Input';
import { Panel } from '../components/ui/Panel';
import { SplitPane } from '../components/ui/SplitPane';
import { cn } from '../utils/cn';
import { AGENTS as REGISTRY } from '../api/agentRegistry';
import { usePageTitle } from '../utils/usePageTitle';

// CRUD 外壳刻意不抽象为通用 hook——四管理页差异面远大于共性(CS1-R19)。
// CS1-R13: 挂载目标单源 agentRegistry(此前本地 11 键, 增删 agent 双处
// 漂移); 语义保持"业务面"——配置三键不进 MCP 挂载目标(与原 11 键一致)。
const CONFIG_AGENT_KEYS = ['skill-config', 'mcp-config', 'cli-config'];
const AGENTS = REGISTRY.map(a => a.id).filter(id => !CONFIG_AGENT_KEYS.includes(id));

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
  const [arm, setArm] = useState<string | null>(null);
  usePageTitle('MCP 服务器'); // FEVERIFY-N3
  const [servers, setServers] = useState<McpServer[]>([]);
  const [form, setForm] = useState({
    name: '', transport: 'http' as 'http' | 'stdio',
    url: '', headersJson: '', commandStr: '',
    where: 'host' as 'host' | 'sandbox', agents: ['recon'] as string[],
  });
  const [testing, setTesting] = useState<Record<string, boolean>>({});  // P3-8: 并发计数(单槽失真)
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
    setTesting(t => ({ ...t, [name]: true }));
    setResults(r => ({ ...r, [name]: '…' }));
    try {
      const res = await api<{ ok: boolean; serverName?: string;
        tools?: string[]; error?: string }>('/sandbox/mcp/test',
        { method: 'POST', json: { name } });
      setResults(r => ({ ...r, [name]: res.ok
        ? `✓ ${res.serverName} — 工具: ${(res.tools ?? []).join(', ') || '无'}`
        : `✗ ${res.error}` }));
    } catch (e) { setResults(r => ({ ...r, [name]: `✗ ${String(e)}` })); }
    finally { setTesting(t => { const n = { ...t }; delete n[name]; return n; }); }
  };

  const remove = async (name: string) => {
    // r50e: 两击确认(禁原生弹窗)
    try {
      await api(`/sandbox/mcp?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      setMsg(`已注销 ${name}`);
      await load();
    } catch (e) { setMsg(String(e)); }
  };

  return (
    <SplitPane storageKey="spectre.split.mcp-v3" initial={0.42}>
      <div className="flex min-h-0 min-w-0 flex-col gap-3">

      <Panel title="注册新 Server" className="shrink-0" bodyClassName="p-3 space-y-2">
        <Input
          value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
          placeholder="名称（如 shodan）"
        />
        <div className="flex gap-2">
          {(['http', 'stdio'] as const).map(t => (
            <button key={t} onClick={() => setForm({ ...form, transport: t })}
              className={cn('flex-1 rounded-md border px-3 py-1.5 min-h-8 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                form.transport === t ? 'border-accent-text bg-accent-subtle text-accent-text' : 'border-line-strong bg-surface text-secondary hover:bg-surface-2')}>
              {t === 'http' ? '远程 HTTP' : '本地 stdio'}
            </button>
          ))}
        </div>
        {form.transport === 'http' ? (
          <>
            <Input
              value={form.url} onChange={e => setForm({ ...form, url: e.target.value })}
              placeholder="https://your-host/mcp（用户自建机器）"
            />
            <Textarea
              value={form.headersJson} onChange={e => setForm({ ...form, headersJson: e.target.value })}
              rows={2} placeholder='{"Authorization":"Bearer …"}'
              className="font-mono"
            />
          </>
        ) : (
          <>
            <Input
              value={form.commandStr} onChange={e => setForm({ ...form, commandStr: e.target.value })}
              placeholder="启动命令（如 node /opt/mcp-shodan.mjs）"
              className="font-mono"
            />
            <div className="flex gap-2">
              {(['host', 'sandbox'] as const).map(w => (
                <button key={w} onClick={() => setForm({ ...form, where: w })}
                  className={cn('flex-1 rounded-md border px-3 py-1.5 min-h-8 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                    form.where === w ? 'border-accent-text bg-accent-subtle text-accent-text' : 'border-line-strong bg-surface text-secondary hover:bg-surface-2')}>
                  {w === 'host' ? '宿主进程' : '沙箱内进程'}
                </button>
              ))}
            </div>
          </>
        )}
        <div>
          <Label className="mb-1 block text-xs">挂载 Agent</Label>
          <div className="flex flex-wrap gap-1">
            {AGENTS.map(a => (
              <button key={a} onClick={() => toggleAgent(a)}
                aria-pressed={form.agents.includes(a)}
                className={cn('rounded-md px-2.5 min-h-8 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                  form.agents.includes(a) ? 'bg-accent-subtle text-accent-text border border-accent-text' : 'bg-surface-2 text-secondary border border-line-strong hover:bg-surface-3')}>
                {a}
              </button>
            ))}
          </div>
        </div>
        <Button
          onClick={() => void create()}
          disabled={busy}
          variant="primary"
          size="sm"
          className="w-full"
        >
          <Plus className="h-3.5 w-3.5" /> 注册并挂载
        </Button>
        {msg && <p className="text-xs text-warning-text">{msg}</p>}
      </Panel>
      <div className="flex min-h-0 flex-1 flex-col"><ToolingChat agentKey="mcp-config" workSessionId={wsId} /></div>
      </div>

      <Panel title="已注册 MCP Servers" className="h-full min-h-0" bodyClassName="flex min-h-0 flex-col p-0">
        <div className="min-h-0 flex-1 overflow-auto"><table className="w-full text-left">
          <thead>
            <tr className="text-xs font-medium text-tertiary">
              <th className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2 text-left font-medium">名称</th>
              <th className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2 text-left font-medium">传输</th>
              <th className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2 text-left font-medium">挂载 Agent</th>
              <th className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2 text-left font-medium">连接</th>
              <th className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {servers.map(s => (
              <tr key={s.name} className="odd:bg-surface-2/50 hover:bg-surface-2">
                <td className="px-3 py-2.5">
                  <div className="font-mono text-[13px] text-primary">{s.name}</div>
                  <div className="mt-0.5 flex items-center gap-1 font-mono text-xs text-tertiary">
                    {s.transport === 'http'
                      ? <><Globe className="h-3 w-3" />{s.url}</>
                      : <><Terminal className="h-3 w-3" />{(s.command ?? []).join(' ')} @{s.where}</>}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <Badge tone={s.transport === 'http' ? 'info' : 'neutral'}>
                    {s.transport}
                  </Badge>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {(s.agents ?? []).map(a => (
                      <Badge key={a} tone="accent">{a}</Badge>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <Button
                    onClick={() => void test(s.name)}
                    disabled={testing[s.name]}
                    variant="secondary"
                    size="sm"
                  >
                    <PlugZap className="h-3.5 w-3.5" /> {testing[s.name] ? '测试中' : '连通测试'}
                  </Button>
                  {results[s.name] && (
                    <div className={cn('mt-1 max-w-56 break-all text-xs leading-snug',
                      results[s.name].startsWith('✓') ? 'text-success-text' : 'text-danger-text')} title={results[s.name]}>
                      {results[s.name]}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <button
                    onClick={() => { if (arm !== s.name) { setArm(s.name); setTimeout(() => setArm(a => a === s.name ? null : a), 2500); return; } setArm(null); void remove(s.name); }}
                    aria-label={`注销 ${s.name}`}
                    title={`注销 ${s.name}`}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-tertiary hover:bg-surface-2 hover:text-danger-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
            {servers.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-8">
                <EmptyState icon={PlugZap} title="暂无注册"
                  hint="远程 server 填 URL 直连；本地 server 填启动命令" />
              </td></tr>
            )}
          </tbody>
        </table></div>
      </Panel>
    </SplitPane>
  );
}
