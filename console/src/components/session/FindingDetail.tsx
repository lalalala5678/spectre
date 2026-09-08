import { CornerUpLeft } from 'lucide-react';

import type { ApiBusEvent } from '../../api/client';
import { Markdown } from './Markdown';
import { SeverityBadge, StatusBadge } from './FindingsPanel';

/**
 * FINDING detail view — replaces the main conversation window temporarily.
 * Severity + title + meta header, then the full markdown content
 * (description, evidence, reproduction steps / PoC).
 */
export function FindingDetail({ event, onBack }: {
  event: ApiBusEvent;
  onBack: () => void;
}) {
  const isReport = event.type === 'task-report';
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
          {isReport
            ? <StatusBadge status={event.status ?? 'no-result'} />
            : <SeverityBadge severity={severity} />}
          <h2 className="text-[15px] font-semibold text-zinc-100">
            {isReport ? `任务报告 · ${title}` : title}
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
        </div>
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
