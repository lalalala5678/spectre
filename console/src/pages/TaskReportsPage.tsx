import { SplitPane } from '../components/ui/SplitPane';
import { useEffect, useState } from 'react';
import { ClipboardList } from 'lucide-react';

import type { ApiBusEvent } from '../api/client';
import { getPrefs } from '../api/worksession';
import { EmptyState } from '../components/ui/EmptyState';
import { Panel } from '../components/ui/Panel';
import { Skeleton } from '../components/ui/Skeleton';
import { TaskReportsPanel } from '../components/session/TaskReportsPanel';
import { EntryDetail } from '../components/session/EntryDetail';
import { usePageTitle } from '../utils/usePageTitle';

/** 任务报告页 — 全项目的任务报告流（配置/安装/卸载等闭环的最终
 *  交付物）。复用会话侧 TaskReportsPanel（SSE 驱动 + 修订折叠），
 *  提供全宽列表 + 详情侧栏。 */
export function TaskReportsPage() {
  usePageTitle('任务报告'); // FEVERIFY-N3
  const [wsId, setWsId] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<ApiBusEvent | null>(null);

  useEffect(() => {
    getPrefs().then(p => setWsId(p.currentWs ?? ''))  // R16-F3: null 哨兵双义永久卡加载
      .catch(e => setErr(String(e)));
  }, []);

  return (
    <SplitPane storageKey="spectre.split.taskreports" initial={0.5}>
      <div className="flex min-w-0 min-h-0 flex-col gap-3">
        {selected
          ? <div className="flex min-h-0 flex-1 flex-col overflow-hidden"><EntryDetail event={selected} onBack={() => setSelected(null)} /></div>
          : (
            <Panel title="报告详情" className="flex-1" bodyClassName="p-6">
              <EmptyState icon={ClipboardList} title="选择右侧报告查看详情"
                hint="状态、行动、证据、验证会话、修订历史" />
            </Panel>
          )}
      </div>

      <Panel
        title="任务报告"
        right={
          <span className="flex items-center gap-1 text-xs text-tertiary">
            <ClipboardList className="h-3 w-3 text-accent-text/80" />
            安装/卸载/渗透任务的闭环交付记录
          </span>
        }
        className="h-full min-h-0 min-w-0"
        bodyClassName="p-0"
      >
        <div className="h-full max-h-[calc(100vh-180px)] overflow-y-auto">
          {err && <p className="p-4 text-[13px] text-danger-text">项目信息加载失败:{err}</p>}
          {!err && wsId === null && (
            <div className="space-y-2 p-4">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}
          {!err && wsId === '' && (
            <p className="p-6 text-center text-[13px] text-tertiary">无当前项目,请先在顶栏选择</p>
          )}
          {!err && wsId && (
            <TaskReportsPanel workSessionId={wsId} onOpen={setSelected} />
          )}
        </div>
      </Panel>
    </SplitPane>
  );
}
