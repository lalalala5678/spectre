/** SpawnLimitSettings — 调度限制; CS44-F17 拆出。 */
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Panel } from '../ui/Panel';

interface SpawnSettings {
  spawnMaxDepth: number;
  spawnMaxAgents: number;
}

/** 调度限制(spawn policy)— runtime-enforced, console-edited. */
export function SpawnLimitSettings() {
  const [settings, setSettings] = useState<SpawnSettings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api<SpawnSettings>('/settings')
      .then(setSettings)
      .catch(() => { /* gateway re-auth */ });
  }, []);

  const save = async () => {
    if (!settings) return;
    await api<SpawnSettings>('/settings', {
      method: 'PUT',
      json: {
        spawnMaxDepth: settings.spawnMaxDepth,
        spawnMaxAgents: settings.spawnMaxAgents,
      },
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <Panel title="调度限制">
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
            派生深度上限(主控=0 层)
          </span>
          <input
            type="number" min={1} max={10}
            value={settings?.spawnMaxDepth ?? ''}
            onChange={e => setSettings(s => s && ({
              ...s, spawnMaxDepth: Number(e.target.value) || 1,
            }))}
            className="w-full rounded-sm border border-void-600 bg-void-900 px-2 py-1.5 font-mono text-[12px] text-zinc-200 outline-none focus:border-orange-700"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
            单树智能体总数上限
          </span>
          <input
            type="number" min={1} max={64}
            value={settings?.spawnMaxAgents ?? ''}
            onChange={e => setSettings(s => s && ({
              ...s, spawnMaxAgents: Number(e.target.value) || 1,
            }))}
            className="w-full rounded-sm border border-void-600 bg-void-900 px-2 py-1.5 font-mono text-[12px] text-zinc-200 outline-none focus:border-orange-700"
          />
        </label>
        <div className="flex items-center gap-2">
          <button
            onClick={save}
            disabled={!settings}
            className="rounded-sm bg-orange-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-orange-500 disabled:opacity-30"
          >
            保存
          </button>
          {saved && <span className="text-[10px] text-emerald-400">已生效</span>}
        </div>
      </div>
    </Panel>
  );
}
