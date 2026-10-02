import { useEffect, useState } from 'react';
import { Package, RefreshCw, Terminal, Trash2 } from 'lucide-react';

import { api } from '../api/client';
import { ToolingChat } from '../components/ToolingChat';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { Textarea } from '../components/ui/Input';
import { Panel } from '../components/ui/Panel';
import { cn } from '../utils/cn';
import { usePageTitle } from '../utils/usePageTitle';

interface SandboxStatus {
  driver: 'local' | 'docker';
  container: string;
  image: string;
}

/** CLI 工具页 — 共享工具层：安装一次，全部 agent（全部项目）可用。
 *  安装命令在沙箱内执行并经挂载卷持久化。 */
export function CliPage({ wsId }: { wsId: string }) {
  usePageTitle('CLI 工具'); // FEVERIFY-N3
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [tools, setTools] = useState<string[]>([]);
  interface InstalledTool { name: string; layer: string; note?: string }
  const [installed, setInstalled] = useState<InstalledTool[]>([]);
  const [cmd, setCmd] = useState('');
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    try {
      setStatus(await api<SandboxStatus>('/sandbox/status'));
      setTools(await api<string[]>('/sandbox/tools'));
      setInstalled(await api<InstalledTool[]>('/sandbox/cli/installed'));
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
      await load();
    } catch (e) { setMsg(String(e)); } finally { setBusy(false); }
  };

  const uninstall = async (name: string) => {
    if (busy) return;
    if (!window.confirm(`卸载 ${name}?(删除共享层文件并清除安装记录)`)) return;
    setBusy(true); setMsg(`正在卸载 ${name}…`);
    try {
      const r = await api<{ removed: string[]; clearedLog: string[] }>(
        `/sandbox/cli?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      setMsg(r.removed.length
        ? `已卸载 ${name}(清除记录 ${r.clearedLog.length} 条)`
        : `未找到 ${name} 的安装痕迹`);
    } catch (e) { setMsg(String(e)); }
    finally {
      await load();
      setBusy(false);
    }
  };

  return (
    <div className="grid h-full grid-cols-1 gap-3 xl:grid-cols-3">
      <Panel
        title="已安装 CLI（共享层）"
        right={
          <Button
            onClick={() => void load()}
            variant="secondary"
            size="sm"
          >
            <RefreshCw className="h-3 w-3" /> 刷新
          </Button>
        }
        className="min-h-0 xl:col-span-2"
        bodyClassName="p-0"
      >
        <div className="max-h-[60vh] overflow-y-auto p-3" tabIndex={0} aria-label="已安装 CLI 列表">
          <p className="mb-1 text-[13px] font-semibold text-tertiary">
            共享层已安装（{installed.length}，可卸载）
          </p>
          <div className="mb-3 flex flex-wrap gap-1">
            {installed.map(t => (
              <span key={t.layer + t.name}
                className="group inline-flex items-center gap-1 rounded-full border border-line bg-accent-subtle px-2 py-1 text-[13px] font-medium text-accent-text"
                title={t.note ? `layer=${t.layer}\n${t.note}` : `layer=${t.layer}`}>
                {t.name}
                <span className="text-xs text-tertiary">{t.layer}</span>
                <button
                  onClick={() => void uninstall(t.name)}
                  aria-label={`卸载 ${t.name}`}
                  title={`卸载 ${t.name}`}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-tertiary hover:text-danger-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
            {installed.length === 0 && (
              <span className="py-1 text-[13px] text-tertiary">未安装 — 用下方安装框或对话安装</span>
            )}
          </div>
          <p className="mb-1 text-[13px] font-semibold text-tertiary">
            沙箱可用命令（PATH，系统级）
          </p>
          <div className="flex flex-wrap gap-1">
            {tools.map(t => (
              <Badge key={t} tone="neutral" className="font-mono">{t}</Badge>
            ))}
            {tools.length === 0 && (
              <EmptyState icon={Package} title="未列出"
                hint="安装后自动索引" className="min-h-20 p-2" />
            )}
          </div>
        </div>
      </Panel>

      <div className="flex min-h-0 flex-col gap-3">
      <Panel title="安装到沙箱" bodyClassName="p-3 space-y-2">
        {status && (
          <p className="flex items-center gap-1.5 text-xs text-tertiary">
            <Package className="h-3.5 w-3.5 text-accent-text/80" />
            driver={status.driver}
            {status.driver === 'docker' && ` container=${status.container} image=${status.image}`}
            {status.driver !== 'docker' && ' local 驱动=安装到宿主机(包管理器命令须服务端 SPECTRE_ALLOW_HOST_BOOTSTRAP=1)'}
          </p>
        )}
        <Textarea
          value={cmd} onChange={e => setCmd(e.target.value)}
          rows={3}
          placeholder={'安装命令（shell），例如：\napt-get update && apt-get install -y nmap\n或 pip install httpx'}
          className="font-mono"
        />
        <Button
          onClick={() => void install()}
          disabled={busy}
          variant="primary"
          size="sm"
          className="w-full"
        >
          <Terminal className="h-3 w-3" /> {busy ? '执行中…' : '执行安装'}
        </Button>
        {msg && <p className={cn('text-[13px]', msg.includes('完成') ? 'text-success-text' : 'text-warning-text')}>{msg}</p>}
        {output && (
          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-bg p-2 font-mono text-[13px] leading-6 text-secondary">
            {output}
          </pre>
        )}
        <p className="text-[13px] leading-relaxed text-tertiary">
          安装一次，全部项目的全部 agent 共享（环境能力）；项目间的隔离靠各自工作目录，CLI 层刻意共享。
        </p>
      </Panel>
      <ToolingChat agentKey="cli-config" workSessionId={wsId} />
      </div>
    </div>
  );
}
