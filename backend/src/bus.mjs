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
   *          detail?: string|null}} entry
   *
   * `severity`/`title`/`detail` carry structured FINDING payloads:
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
      summary: String(entry.summary || '').slice(0, 500),
      payloadRef: entry.payloadRef ?? null,
      engagement: entry.engagement ?? null,
      severity: entry.severity ?? null,
      title: entry.title ?? null,
      origin: entry.origin ?? null,
      workSessionId: entry.workSessionId ?? null,
      status: entry.status ?? null,
      author: entry.author ?? null,
      detail: entry.detail ? clipMarked(entry.detail, CONFIG.busDetailMaxChars) : null,
    };
    // Idempotency for FINDING publications: an agent re-calling the tool
    // with the same title+severity (receipt-style duplicates) is a no-op.
    if (entry.type === 'intel' && entry.title && entry.severity) {
      const dup = [...this.events].reverse().find(e =>
        e.type === 'intel' && e.from === entry.from
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
      client.write(frame);
    }
  }
}
