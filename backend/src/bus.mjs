/**
 * Message bus journal.
 *
 * Append-only record of inter-agent traffic (announce / dm / share) plus
 * SSE fan-out to console subscribers. Bus writes are internal-token only —
 * the console reads, Temporal activities write.
 */

import { CONFIG } from './config.mjs';
import { clipMarked } from './pi.mjs';

let seq = 0;
export class Bus {
  constructor(wal = null) {
    this.events = [];
    this.clients = new Set();
    this.wal = wal;
  }

  /** Replay persisted events (boot recovery); seq continues past the max.
   *  Truncated to the in-memory journal limit — WAL may hold more. */
  load(events) {
    const trimmed = events.length > CONFIG.busJournalLimit
      ? events.slice(-CONFIG.busJournalLimit) : events;
    this.events = trimmed;
    seq = trimmed.reduce((m, e) => Math.max(m, e.seq), 0);
  }

  /**
   * @param {{channel: string, from: string, to?: string, type?: string,
   *          summary: string, payloadRef?: string|null,
   *          engagement?: string|null,
   *          severity?: string|null, title?: string|null,
   *          origin?: string|null, workSessionId?: string|null,
   *          status?: string|null, author?: string|null,
   *          revises?: number|null, void?: number|null,
   *          revision?: {n: number, reason?: string,
   *                       requestedBy?: string, approvedBy?: string}|null,
   *          requester?: string|null,
   *          detail?: string|null}} entry
   *
   * CS23-N10: origin/workSessionId/status/author 四字段此前 JSDoc 漏载
   * 而 emit 白名单实收——文档与白名单对齐。
   *
   * `severity`/`title`/`detail` carry structured vulnerability payloads:
   * the panel lists severity + title and expands the full detail.
   */
  emit(entry) {
    const event = {
      seq: ++seq,
      ts: new Date().toISOString(),
      channel: entry.channel,
      from: entry.from,
      to: entry.to || 'all',
      type: entry.type || 'context',
      // CS44-F2: 静默截断→单源打标(与 detail 的 clipMarked 同纪律; 此前
      // 裸切 500, query_intel 消费侧据已切文本谎报总数)。
      summary: String(entry.summary || '').slice(0, 500),
      summaryClipped: String(entry.summary || '').length > 500,
      payloadRef: entry.payloadRef ?? null,
      engagement: entry.engagement ?? null,
      severity: entry.severity ?? null,
      title: entry.title ?? null,
      origin: entry.origin ?? null,
      workSessionId: entry.workSessionId ?? null,
      status: entry.status ?? null,
      author: entry.author ?? null,
      // revision chain (append-only: a revision is a NEW event pointing
      // at the original seq) + discoverer attribution on writer-published
      // vulnerabilities — previously silently dropped by this whitelist.
      revises: entry.revises ?? null,
      void: entry.void ?? null,
      revision: entry.revision ?? null,
      requester: entry.requester ?? null,
      detail: entry.detail ? clipMarked(entry.detail, CONFIG.busDetailMaxChars) : null,
    };
    // Idempotency for vulnerability/intel publications(CS67-4: 代码两
    // 分支, 注释此前只提 vulnerability): 同 title+severity 重复落账
    // (receipt 式重发)幂等 no-op。
    if ((entry.type === 'vulnerability' || entry.type === 'intel')
      && entry.title && entry.severity && !entry.revises) {
      const dup = [...this.events].reverse().find(e =>
        (e.type === 'vulnerability' || e.type === 'intel') && e.from === entry.from
        && e.title === entry.title && e.severity === entry.severity);
      if (dup) return dup;
    }
    // Write-ahead: durable on disk before it exists in memory/SSE.
    this.wal?.append({ t: 'bus', d: event });
    this.events.push(event);
    if (this.events.length > CONFIG.busJournalLimit) {
      this.events.splice(0, this.events.length - CONFIG.busJournalLimit);
    }
    this._broadcast(event);
    return event;
  }

  list(since = 0) {
    return this.events.filter(e => e.seq > since);
  }

  /** Replay past `since`, then attach the SSE client. */
  attach(stream, since = 0) {
    for (const event of this.list(since)) {
      stream.write(`event: bus\ndata: ${JSON.stringify(event)}\n\n`);
    }
    this.clients.add(stream);
    stream.on('close', () => this.clients.delete(stream));
  }

  _broadcast(event) {
    const frame = `event: bus\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      // R26-F4: 背压记账(sessions._broadcast 同款)
      if (client.write(frame)) {
        client.__congested = 0;
      } else if ((client.__congested = (client.__congested || 0) + 1) >= 500) {
        client.destroy();
      }
    }
  }
}
