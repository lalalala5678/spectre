import { useEffect, useState } from 'react';
import { Package, RefreshCw, Terminal } from 'lucide-react';

import { api } from '../api/client';
import { ToolingChat } from '../components/ToolingChat';
import { Panel } from '../components/ui/Panel';
import { cn } from '../utils/cn';

interface SandboxStatus {
  driver: 'local' | 'docker';
  container: string;
  image: string;
  dockerAvailable?: boolean;
}

/** CLI 工具页 — 共享工具层：安装一次，全部 agent（全部项目）可用。
 *  安装命令在沙箱内执行并经挂载卷持久化。 */
export function CliPage({ wsId }: { wsId: string }) {
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [tools, setTools] = useState<string[]>([]);
  const [cmd, setCmd] = useState('');
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    try {
      setStatus(await api<SandboxStatus>('/sandbox/status'));
      setTools(await api<string[]>('/sandbox/tools'));
    } catch (e) { setMsg(String(e)); }
  };
  useEffect(() => { void load(); }, []);

  const install = async () => {
    if (!cmd.trim()) return;
    setBusy(true); setOutput(''); setMsg('');
    try {
      const res = await api<{ ok: boolean; exitCode: number; output: string }>(
        '/sandbox/cli', { method: 'POST', json: { command: cmd } });
      setOutput(res.output);
      setMsg(res.ok ? '安装完成' : `退出码 ${res.exitCode}`);
      setTools(await api<string[]>('/sandbox/tools'));
    } catch (e) { setMsg(String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="grid h-full grid-cols-1 gap-3 xl:grid-cols-3">
      <Panel
        title="已安装 CLI（共享层）"
        right={
          <button
            onClick={() => void load()}
            className="flex items-center gap-1 rounded-sm border border-void-600 px-2 py-1 text-[10px] text-zinc-400 hover:border-void-400"
          >
            <RefreshCw className="h-3 w-3" /> 刷新
          </button>
        }
        className="min-h-0 xl:col-span-2"
        bodyClassName="p-0"
      >
        <div className="max-h-[60vh] overflow-y-auto p-3">
          <div className="flex flex-wrap gap-1">
            {tools.map(t => (
              <span key={t}
                className="rounded-sm border border-void-700 bg-void-900 px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-400">
                {t}
              </span>
            ))}
            {tools.length === 0 && (
              <p className="py-6 text-center text-[11px] text-zinc-600">未列出 — 安装后自动索引</p>
            )}
          </div>
        </div>
      </Panel>

      <div className="flex min-h-0 flex-col gap-3">
      <Panel title="安装到沙箱" bodyClassName="p-3 space-y-2">
        {status && (
          <p className="flex items-center gap-1.5 font-mono text-[10.5px] text-zinc-500">
            <Package className="h-3.5 w-3.5 text-orange-400/80" />
            driver={status.driver}
            {status.driver === 'docker' && ` container=${status.container} image=${status.image}`}
          </p>
        )}
        <textarea
          value={cmd} onChange={e => setCmd(e.target.value)}
          rows={3}
          placeholder={'安装命令（shell），例如：\napt-get update && apt-get install -y nmap\n或 pip install httpx'}
          className="w-full rounded-sm border border-void-600 bg-void-900 px-2 py-1.5 font-mono text-[11.5px] text-zinc-200 placeholder:text-zinc-600"
        />
        <button
          onClick={() => void install()}
          disabled={busy}
          className="flex w-full items-center justify-center gap-1 rounded-sm bg-orange-600 px-2 py-1.5 text-[11px] font-medium text-white hover:bg-orange-500 disabled:opacity-50"
        >
          <Terminal className="h-3 w-3" /> {busy ? '执行中…' : '执行安装'}
        </button>
        {msg && <p className={cn('font-mono text-[10.5px]', msg.includes('完成') ? 'text-emerald-400' : 'text-amber-400')}>{msg}</p>}
        {output && (
          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-sm border border-void-700 bg-void-950 p-2 font-mono text-[10px] leading-relaxed text-zinc-400">
            {output}
          </pre>
        )}
        <p className="text-[11px] leading-relaxed text-zinc-500">
          安装一次，全部项目的全部 agent 共享（环境能力）；项目间的隔离靠各自工作目录，CLI 层刻意共享。
        </p>
      </Panel>
      <ToolingChat agentKey="cli-config" workSessionId={wsId} />
      </div>
    </div>
  );
}
