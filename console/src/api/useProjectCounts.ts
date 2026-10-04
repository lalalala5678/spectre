/**
 * useProjectCounts — AutoPwn 态势条计数(漏洞/情报)。
 * 用户令: 只统计**当前会话树**成员的产出(payloadRef 指向树内会话),
 * 不再是项目全量。快照 /bus?ws= + 共享 SSE 实时自增。
 * 'intel' = 改名前遗留事件类型, 与 'vulnerability' 同为漏洞。
 */
import { useEffect, useState } from 'react';

import { api, subscribeBus, type ApiBusEvent } from './client';

export function useProjectCounts(ws?: string, treeIds?: Set<string>): { vulns: number; intel: number } | null {
  const [counts, setCounts] = useState<{ vulns: number; intel: number } | null>(null);

  useEffect(() => {
    if (!ws) return;  // 仅 AutoPwn 工作台消费; ws 未解析时不请求
    let stopped = false;
    (async () => {
      try {
        const all = await api<ApiBusEvent[]>(`/bus?ws=${encodeURIComponent(ws)}`);
        if (stopped) return;
        const inTree = (e: ApiBusEvent) => !treeIds
          || (e.payloadRef?.startsWith('sess:') && treeIds.has(e.payloadRef.slice(5)));
        const next = { vulns: 0, intel: 0 };
        for (const e of all) {
          if (e.revises || !inTree(e)) continue;
          if (e.type === 'vulnerability' || e.type === 'intel') next.vulns += 1;
          else if (e.type === 'intel-note') next.intel += 1;
        }
        setCounts(prev =>
          prev?.vulns === next.vulns && prev?.intel === next.intel ? prev : next);
      } catch { /* SSE 自愈 */ }
    })();
    const off = subscribeBus((name, raw) => {
      if (name !== 'bus') return;
      const e = raw as ApiBusEvent;
      if (e.revises || e.workSessionId !== ws) return;
      if (treeIds && !(e.payloadRef?.startsWith('sess:') && treeIds.has(e.payloadRef.slice(5)))) return;
      if (e.type === 'vulnerability' || e.type === 'intel') {
        setCounts(c => (c ? { ...c, vulns: c.vulns + 1 } : c));
      } else if (e.type === 'intel-note') {
        setCounts(c => (c ? { ...c, intel: c.intel + 1 } : c));
      }
    });
    return () => { stopped = true; off(); };
  }, [ws, treeIds]);
  return counts;
}
