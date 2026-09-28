import { useEffect, useMemo, useState } from 'react';
import { CornerUpLeft, History, Loader2, PencilLine, SendHorizontal } from 'lucide-react';

import {
  api, foldEntries, reviseEntryDirect, reviseEntryViaAgent, subscribeBus,
  type ApiBusEvent,
} from '../../api/client';
import { Markdown } from './Markdown';
import { SeverityBadge, StatusBadge } from './VulnPanel';
import { cn } from '../../utils/cn';

const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
const STATUSES = ['success', 'partial', 'failed', 'no-result'] as const;

/**
 * Entry detail view (漏洞 / 情报 / 任务报告). Shows the CURRENT version
 * (folds the revision chain — newest revision wins, originals stay
 * auditable). Two user revision paths:
 *   · dialog — natural-language instruction routed to the writer
 *     (vulns → the ORIGINAL writer session; notes/reports → fresh writer)
 *   · direct edit — form edit, human is the final authority, lands now
 */
export function EntryDetail({ event, onBack, onOpenSession }: {
  event: ApiBusEvent;
  onBack: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const isReport = event.type === 'task-report';
  const isNote = event.type === 'intel-note';
  const isVuln = !isReport && !isNote;

  // Live revision chain: refetch on any bus event that revises this seq.
  const [chain, setChain] = useState<ApiBusEvent[]>([]);
  const [dialogText, setDialogText] = useState('');
  const [dialogBusy, setDialogBusy] = useState(false);
  const [writerSessionId, setWriterSessionId] = useState<string | null>(null);
  const [dialogDone, setDialogDone] = useState('');
  const [editing, setEditing] = useState(false);
  const [editBusy, setEditBusy] = useState(false);

  const loadChain = async () => {
    try {
      const all = await api<ApiBusEvent[]>('/bus'
        + (event.workSessionId ? `?ws=${event.workSessionId}` : ''));
      setChain(all.filter(e => e.seq === event.seq || e.revises === event.seq));
    } catch { /* SSE will heal */ }
  };
  useEffect(() => { void loadChain(); }, [event.seq]);
  useEffect(() => subscribeBus((name, raw) => {
    if (name !== 'bus') return;
    const e = raw as ApiBusEvent;
    if (e.revises === event.seq) {
      void loadChain();
      setDialogDone(`修订已落账（第 ${e.revision?.n ?? '?'} 次）`);
      setDialogBusy(false);
    }
  }), [event.seq]);

  const folded = useMemo(
    () => foldEntries(chain)[0] ?? { ...event, current: event, revisedCount: 0 },
    [chain, event]);
  const current = folded.current;
  const severity = current.severity ?? 'info';
  const title = current.title
    ?? current.summary.replace(/^(情报上报|产出)[:：]?/, '');
  const revisions = useMemo(
    () => chain.filter(e => e.revises === event.seq)
      .sort((a, b) => (b.revision?.n ?? 0) - (a.revision?.n ?? 0)),
    [chain, event.seq]);

  const submitDialog = async () => {
    if (!dialogText.trim()) return;
    setDialogBusy(true); setDialogDone('');
    try {
      const r = await reviseEntryViaAgent(event.seq, dialogText.trim());
      setDialogDone(`已提交报告智能体，撰写中…（落账后自动刷新；若被驳回，` +
        `点此查看撰写对话的判定理由）`);
      setWriterSessionId(r.sessionId);
    } catch (err) {
      setDialogDone(`提交失败:${String(err)}`);
      setDialogBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <button
        onClick={onBack}
        className="flex w-fit items-center gap-1 rounded-sm border border-void-600 bg-void-800 px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200"
      >
        <CornerUpLeft className="h-3 w-3" /> 返回对话
      </button>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded border border-void-700 bg-void-950 p-4">
        <div className="mb-1 flex items-center gap-2">
          {isReport && <StatusBadge status={current.status ?? 'no-result'} />}
          {isNote && (
            <span className="rounded-sm border border-teal-700 bg-teal-950/60 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-widest text-teal-300">
              情报
            </span>
          )}
          {isVuln && <SeverityBadge severity={severity} />}
          <h2 className={cn('text-[15px] font-semibold text-zinc-100', folded.current.void && 'text-zinc-500 line-through')}>
            {isReport ? `任务报告 · ${title}` : isNote ? `情报 · ${title}` : title}
          </h2>
          {Boolean(folded.current.void) && (
            <span className="rounded-sm border border-zinc-600 bg-void-800 px-1.5 py-0.5 font-mono text-[9px] tracking-widest text-zinc-500 line-through">
              已作废
            </span>
          )}
          {folded.revisedCount > 0 && (
            <span className="rounded-sm border border-sky-800 bg-sky-950/40 px-1.5 py-0.5 font-mono text-[9px] tracking-widest text-sky-300">
              ⟳ 已修订 {folded.revisedCount} 次
            </span>
          )}
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-3 border-b border-void-700 pb-2 font-mono text-[10.5px] text-zinc-600">
          <span>seq={event.seq}</span>
          <span>{current.ts.replace('T', ' ').slice(0, 19)}</span>
          <span>from: {current.from}</span>
          {current.author && (
            <span title={current.author.treePath}>
              {current.author.name}（{current.author.typeLabel} · L{current.author.depth}）
            </span>
          )}
          {current.engagement && <span>{current.engagement}</span>}
          {current.payloadRef && <span>{current.payloadRef}</span>}
          {current.requester && (
            <span title={current.requester.treePath}>
              发现者: {current.requester.name}（{current.requester.typeLabel}）
            </span>
          )}
        </div>

        {isVuln && current.payloadRef?.startsWith('sess:') && onOpenSession && (
          <button
            onClick={() => onOpenSession(current.payloadRef!.slice(5))}
            className="flex w-fit items-center gap-1.5 rounded-sm border border-orange-800/70 bg-orange-950/20 px-2.5 py-1 text-[11px] text-orange-300/90 hover:border-orange-600"
          >
            查看撰写对话（思考 · 工具调用 · 验证过程）
          </button>
        )}

        {/* revision history */}
        {revisions.length > 0 && (
          <details className="rounded-sm border border-sky-900/40 bg-sky-950/10">
            <summary className="flex cursor-pointer select-none items-center gap-1.5 px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-widest text-sky-400/80">
              <History className="h-3 w-3" /> 修订历史（{revisions.length}）
            </summary>
            <div className="space-y-2 border-t border-sky-900/30 px-3 py-2">
              {revisions.map(r => (
                <div key={r.seq} className="rounded-sm border border-void-700 bg-void-900 px-2.5 py-1.5">
                  <div className="flex flex-wrap items-center gap-2 font-mono text-[9.5px] text-zinc-500">
                    <span>第 {r.revision?.n ?? '?'} 次 · {r.ts.replace('T', ' ').slice(5, 16)}</span>
                    {r.revision?.requestedBy && (
                      <span>申请: {r.revision.requestedBy.name}</span>
                    )}
                    {r.revision?.approvedBy && (
                      <span>核准: {r.revision.approvedBy.name}</span>
                    )}
                  </div>
                  {r.revision?.reason && (
                    <p className="mt-0.5 text-[11px] text-zinc-500">
                      理由:{r.revision.reason}
                    </p>
                  )}
                  <p className="mt-0.5 truncate text-[11.5px] text-zinc-400">
                    现行标题:《{r.title ?? ''}》
                    {r.severity ? ` · ${r.severity}` : r.status ? ` · ${r.status}` : ''}
                  </p>
                </div>
              ))}
              <details className="px-1">
                <summary className="cursor-pointer font-mono text-[9.5px] uppercase tracking-widest text-zinc-600">
                  原始版本（seq={event.seq}）
                </summary>
                <div className="mt-1 whitespace-pre-wrap rounded-sm border border-void-800 bg-void-900/60 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-zinc-500">
                  《{event.title ?? event.summary}》
                  {event.detail ? `\n\n${event.detail}` : ''}
                </div>
              </details>
            </div>
          </details>
        )}

        {editing ? (
          <EditForm
            kind={isReport ? 'report' : isNote ? 'note' : 'vuln'}
            current={current}
            busy={editBusy}
            onCancel={() => setEditing(false)}
            onSave={async fields => {
              setEditBusy(true);
              try {
                await reviseEntryDirect(event.seq, fields,
                  '用户直接编辑', current.workSessionId ?? null);
                setEditing(false);
              } catch (err) {
                alert(`保存失败:${String(err)}`);
              } finally {
                setEditBusy(false);
              }
            }}
          />
        ) : (
          <>
            {current.detail
              ? <Markdown>{current.detail}</Markdown>
              : (
                <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-zinc-400">
                  {current.summary}
                </p>
              )}
            <button
              onClick={() => setEditing(true)}
              className="mt-1 flex w-fit items-center gap-1.5 rounded-sm border border-void-600 bg-void-800 px-2.5 py-1 text-[11px] text-zinc-400 hover:border-void-400 hover:text-zinc-200"
            >
              <PencilLine className="h-3 w-3" /> 直接编辑
            </button>
          </>
        )}

        {/* dialog revision */}
        <div className="mt-2 rounded-sm border border-void-700 bg-void-900/60 p-2.5">
          <p className="mb-1.5 font-mono text-[9.5px] uppercase tracking-widest text-zinc-500">
            修订对话框 → 报告智能体{isVuln ? '（原撰写者审核）' : ''}
          </p>
          <div className="flex gap-2">
            <input
              value={dialogText}
              onChange={e => setDialogText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submitDialog(); }}
              placeholder="描述如何更改,如:severity 改为 high,补充 PoC 步骤…"
              className="min-w-0 flex-1 rounded-sm border border-void-600 bg-void-950 px-2.5 py-1.5 text-[12px] text-zinc-200 placeholder:text-zinc-700 focus:border-orange-700 focus:outline-none"
            />
            <button
              onClick={() => void submitDialog()}
              disabled={dialogBusy || !dialogText.trim()}
              className="flex items-center gap-1.5 rounded-sm border border-orange-800/70 bg-orange-950/30 px-3 py-1.5 text-[11px] text-orange-300/90 hover:border-orange-600 disabled:opacity-40"
            >
              {dialogBusy
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <SendHorizontal className="h-3 w-3" />}
              {dialogBusy ? '撰写中' : '提交'}
            </button>
          </div>
          {dialogDone && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
              <p className={cn(dialogDone.includes('失败') ? 'text-red-400' : 'text-sky-400')}>
                {dialogDone}
              </p>
              {writerSessionId && onOpenSession && (
                <button
                  onClick={() => onOpenSession(writerSessionId)}
                  className="rounded-sm border border-orange-800/70 bg-orange-950/20 px-2 py-0.5 text-[10px] text-orange-300/90 hover:border-orange-600"
                >
                  打开撰写对话
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EditForm({ kind, current, busy, onCancel, onSave }: {
  kind: 'vuln' | 'note' | 'report';
  current: ApiBusEvent;
  busy: boolean;
  onCancel: () => void;
  onSave: (fields: { title?: string; severity?: string; status?: string; text?: string }) => void;
}) {
  const [title, setTitle] = useState(current.title ?? '');
  const [severity, setSeverity] = useState(String(current.severity ?? 'info'));
  const [status, setStatus] = useState(String(current.status ?? 'success'));
  const [text, setText] = useState(current.detail ?? current.summary ?? '');
  return (
    <div className="space-y-2 rounded-sm border border-void-600 bg-void-900 p-3">
      <label className="block">
        <span className="mb-1 block font-mono text-[9.5px] uppercase tracking-widest text-zinc-500">标题</span>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          className="w-full rounded-sm border border-void-600 bg-void-950 px-2.5 py-1.5 text-[13px] text-zinc-100 focus:border-orange-700 focus:outline-none"
        />
      </label>
      <div className="flex gap-3">
        {kind === 'vuln' && (
          <label className="block">
            <span className="mb-1 block font-mono text-[9.5px] uppercase tracking-widest text-zinc-500">severity</span>
            <select
              value={severity}
              onChange={e => setSeverity(e.target.value)}
              className="rounded-sm border border-void-600 bg-void-950 px-2 py-1.5 text-[12px] text-zinc-200 focus:outline-none"
            >
              {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        )}
        {kind === 'report' && (
          <label className="block">
            <span className="mb-1 block font-mono text-[9.5px] uppercase tracking-widest text-zinc-500">status</span>
            <select
              value={status}
              onChange={e => setStatus(e.target.value)}
              className="rounded-sm border border-void-600 bg-void-950 px-2 py-1.5 text-[12px] text-zinc-200 focus:outline-none"
            >
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        )}
      </div>
      <label className="block">
        <span className="mb-1 block font-mono text-[9.5px] uppercase tracking-widest text-zinc-500">正文（markdown）</span>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={12}
          className="w-full resize-y rounded-sm border border-void-600 bg-void-950 px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-zinc-200 focus:border-orange-700 focus:outline-none"
        />
      </label>
      <div className="flex gap-2">
        <button
          onClick={() => onSave({
            // R2-F4: 原样透传——`|| undefined` 把刻意清空(空串)静默
            // 转成'保持原值', 终审路径无法清空字段(redact 场景尤甚)。
            title,
            ...(kind === 'vuln' ? { severity } : {}),
            ...(kind === 'report' ? { status } : {}),
            text,
          })}
          disabled={busy}
          className="rounded-sm border border-emerald-800/70 bg-emerald-950/30 px-3 py-1 text-[11px] text-emerald-300 hover:border-emerald-600 disabled:opacity-40"
        >
          {busy ? '保存中…' : '保存修订'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-sm border border-void-600 bg-void-800 px-3 py-1 text-[11px] text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
        >
          取消
        </button>
      </div>
    </div>
  );
}
