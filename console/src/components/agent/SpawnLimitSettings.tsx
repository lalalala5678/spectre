/** SpawnLimitSettings — 调度限制; CS44-F17 拆出。 */
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Panel } from '../ui/Panel';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Input';

interface SpawnSettings {
  spawnMaxDepth: number;
  spawnMaxAgents: number;
}

/** 调度限制(spawn policy)— runtime-enforced, console-edited. */
export function SpawnLimitSettings() {
  const [msg, setMsg] = useState('');
  const [settings, setSettings] = useState<SpawnSettings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api<SpawnSettings>('/settings')
      .then(setSettings)
      .catch(() => { /* gateway re-auth */ });
  }, []);

  const save = async () => {
    if (!settings) return;
    try {
      await api<SpawnSettings>('/settings', {
        method: 'PUT',
        json: {
          spawnMaxDepth: settings.spawnMaxDepth,
          spawnMaxAgents: settings.spawnMaxAgents,
        },
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {  // FEVERIFY-P3-10: 保存失败此前裸抛(无提示)
      setSaved(false);
      setMsg(`保存失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <Panel title="调度限制">
      {msg && <p className="text-[13px] text-danger-text">{msg}</p>}
      <div className="space-y-3">
        <label className="block">
          <Label className="mb-1 block">
            派生深度上限(主控=0 层)
          </Label>
          <Input
            type="number" min={1} max={10}
            value={settings?.spawnMaxDepth ?? ''}
            onChange={e => setSettings(s => s && ({
              ...s, spawnMaxDepth: Number(e.target.value) || 1,
            }))}
          />
        </label>
        <label className="block">
          <Label className="mb-1 block">
            单树智能体总数上限
          </Label>
          <Input
            type="number" min={1} max={64}
            value={settings?.spawnMaxAgents ?? ''}
            onChange={e => setSettings(s => s && ({
              ...s, spawnMaxAgents: Number(e.target.value) || 1,
            }))}
          />
        </label>
        <div className="flex items-center gap-2">
          <Button onClick={save} disabled={!settings} variant="primary" size="sm">
            保存
          </Button>
          {saved && <span className="text-xs text-success-text">已生效</span>}
        </div>
      </div>
    </Panel>
  );
}

