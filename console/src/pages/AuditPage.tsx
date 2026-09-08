import { Download } from 'lucide-react';
import { AUDIT_LOG } from '../mock/data';
import { Dot } from '../components/ui/Badge';
import { Panel } from '../components/ui/Panel';

/** 审计与证据链页 */
export function AuditPage() {
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
      <Panel
        title="操作审计链"
        right={
          <button className="flex items-center gap-1 rounded-sm border border-void-600 bg-void-800 px-2 py-1 text-[11px] text-zinc-400 hover:bg-void-700">
            <Download className="h-3 w-3" /> 导出签名日志
          </button>
        }
        className="xl:col-span-2"
        bodyClassName="p-0"
      >
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-void-700 text-[10px] uppercase tracking-wider text-zinc-600">
              <th className="px-3 py-2 font-semibold">时间</th>
              <th className="px-3 py-2 font-semibold">Actor</th>
              <th className="px-3 py-2 font-semibold">动作</th>
              <th className="px-3 py-2 font-semibold">详情</th>
              <th className="px-3 py-2 font-semibold">审批</th>
              <th className="px-3 py-2 font-semibold">哈希</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-void-700">
            {AUDIT_LOG.map((r) => (
              <tr key={r.id} className="hover:bg-void-800/60">
                <td className="px-3 py-2.5 font-mono text-[11px] text-zinc-600">{r.ts}</td>
                <td className="px-3 py-2.5">
                  <span className={`font-mono text-[11px] ${r.actor === 'user' ? 'text-orange-300' : 'text-zinc-400'}`}>{r.actor}</span>
                </td>
                <td className="px-3 py-2.5 font-mono text-[11px] text-zinc-300">{r.action}</td>
                <td className="px-3 py-2.5 text-[11.5px] text-zinc-500">{r.detail}</td>
                <td className="px-3 py-2.5">
                  {r.approved === undefined ? <span className="text-[10px] text-zinc-700">—</span>
                    : r.approved
                      ? <span className="flex items-center gap-1 text-[10px] text-zinc-400"><Dot tone="cyan" />已批准</span>
                      : <span className="flex items-center gap-1 text-[10px] text-red-400"><Dot tone="red" />已拒绝</span>}
                </td>
                <td className="px-3 py-2.5 font-mono text-[10px] text-zinc-700">{r.hash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <div className="space-y-3">
        <Panel title="证据链完整性">
          <div className="space-y-2 text-[11.5px] text-zinc-500">
            <div className="flex justify-between"><span>证据条目</span><span className="font-mono text-zinc-300">47</span></div>
            <div className="flex justify-between"><span>截图 / pcap / 命令输出</span><span className="font-mono text-zinc-300">18 / 4 / 25</span></div>
            <div className="flex justify-between items-center"><span>链式校验</span><span className="flex items-center gap-1 font-mono text-zinc-300"><Dot tone="cyan" />PASS</span></div>
            <div className="flex justify-between"><span>Merkle Root</span><span className="font-mono text-[10px] text-zinc-600">0x9f2a…e7c1</span></div>
          </div>
        </Panel>

        <Panel title="数据保护">
          <p className="text-[11.5px] leading-relaxed text-zinc-600">
            所有证据写入即计算 SHA-256 并追加到链式日志；凭据类数据仅存储于密钥库，会话结束后按策略自动擦除。
            审计日志支持导出为带签名的 JSONL，可直接附入渗透报告附录。
          </p>
        </Panel>
      </div>
    </div>
  );
}
