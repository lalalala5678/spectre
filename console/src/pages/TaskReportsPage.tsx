import { useEffect, useState } from 'react';
import { ClipboardList } from 'lucide-react';

import type { ApiBusEvent } from '../api/client';
import { getPrefs } from '../api/worksession';
import { Panel } from '../components/ui/Panel';
import { TaskReportsPanel } from '../components/session/TaskReportsPanel';
import { EntryDetail } from '../components/session/EntryDetail';

/** 任务报告页 — 全项目的任务报告流（配置/安装/卸载等闭环的最终
 *  交付物）。复用会话侧 TaskReportsPanel（SSE 驱动 + 修订折叠），
 *  提供全宽列表 + 详情侧栏。 */
export function TaskReportsPage() {
  const [wsId, setWsId] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<ApiBusEvent | null>(null);

  useEffect(() => {
    getPrefs().then(p => setWsId(p.currentWs ?? ''))  // R16-F3: null 哨兵双义永久卡加载
      .catch(e => setErr(String(e)));
  }, []);

  return (
    <div className="grid h-full grid-cols-1 gap-3 xl:grid-cols-3">
      <Panel
        title="任务报告"
        right={
          <span className="flex items-center gap-1 font-mono text-[10px] text-zinc-500">
            <ClipboardList className="h-3 w-3 text-orange-400/80" />
            安装/卸载/渗透任务的闭环交付记录
          </span>
        }
        className="min-h-0 xl:col-span-2"
        bodyClassName="p-0"
      >
        <div className="h-full max-h-[calc(100vh-180px)] overflow-y-auto">
          {err && <p className="p-4 text-[11px] text-red-400">项目信息加载失败:{err}</p>}
          {!err && wsId === null && (
            <p className="animate-pulse p-6 text-center text-[11px] text-zinc-600">正在加载项目…</p>
          )}
          {!err && wsId === '' && (
            <p className="p-6 text-center text-[11px] text-zinc-600">无当前项目,请先在顶栏选择</p>
          )}
          {!err && wsId && (
            <TaskReportsPanel workSessionId={wsId} onOpen={setSelected} />
          )}
        </div>
      </Panel>
      <div className="flex min-h-0 flex-col gap-3">
        {selected
          ? <EntryDetail event={selected} onBack={() => setSelected(null)} />
          : (
            <Panel title="报告详情" bodyClassName="p-6">
              <p className="text-center text-[11px] text-zinc-600">
                点击左侧任一任务报告查看全文
                （状态、行动、证据、验证会话、修订历史）
              </p>
            </Panel>
          )}
      </div>
    </div>
  );
}
