import { CornerUpLeft } from 'lucide-react';

import type { ApiBusEvent } from '../../api/client';
import { Markdown } from './Markdown';
import { SeverityBadge, StatusBadge } from './VulnPanel';

/**
 * Entry detail view (漏洞 / 情报 / 任务报告) — replaces the main
 * conversation window temporarily. Kind badge + title + meta header,
 * then the full markdown content.
 */
export function EntryDetail({ event, onBack, onOpenSession }: {
  event: ApiBusEvent;
  onBack: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const isReport = event.type === 'task-report';
  const isNote = event.type === 'intel-note';
  const severity = event.severity ?? (event.type === 'result' ? 'INFO' : 'RAW');
  const title = event.title
    ?? event.summary.replace(/^(情报上报|产出)[:：]?/, '');
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <button
        onClick={onBack}
        className="flex w-fit items-center gap-1 rounded-sm border border-void-600 bg-void-800 px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200"
      >
        <CornerUpLeft className="h-3 w-3" /> 返回对话
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto rounded border border-void-700 bg-void-950 p-4">
        <div className="mb-1 flex items-center gap-2">
          {isReport && <StatusBadge status={event.status ?? 'no-result'} />}
          {isNote && (
            <span className="rounded-sm border border-teal-700 bg-teal-950/60 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-widest text-teal-300">
              情报
            </span>
          )}
          {!isReport && !isNote && <SeverityBadge severity={severity} />}
          <h2 className="text-[15px] font-semibold text-zinc-100">
            {isReport ? `任务报告 · ${title}` : isNote ? `情报 · ${title}` : title}
          </h2>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-3 border-b border-void-700 pb-2 font-mono text-[10.5px] text-zinc-600">
          <span>{event.ts.replace('T', ' ').slice(0, 19)}</span>
          <span>from: {event.from}</span>
          {event.author && (
            <span title={event.author.treePath}>
              {event.author.name}（{event.author.typeLabel}
              {event.author.parent ? ` · 父:${event.author.parent.name}` : ''}
              {` · L${event.author.depth} · ${event.author.treePath}`}
              ）
            </span>
          )}
          {event.engagement && <span>{event.engagement}</span>}
          {event.payloadRef && <span>{event.payloadRef}</span>}
          {event.requester && (
            <span title={event.requester.treePath}>
              发现者: {event.requester.name}（{event.requester.typeLabel}）
            </span>
          )}
        </div>
        {!isReport && !isNote && event.payloadRef?.startsWith('sess:')
          && onOpenSession && (
            <button
              onClick={() => onOpenSession(event.payloadRef!.slice(5))}
              className="mb-3 flex w-fit items-center gap-1.5 rounded-sm border border-orange-800/70 bg-orange-950/20 px-2.5 py-1 text-[11px] text-orange-300/90 hover:border-orange-600"
            >
              查看撰写对话（思考 · 工具调用 · 验证过程）
            </button>
          )}
        {event.detail
          ? <Markdown>{event.detail}</Markdown>
          : (
            <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-zinc-400">
              {event.summary}
            </p>
          )}
      </div>
    </div>
  );
}
