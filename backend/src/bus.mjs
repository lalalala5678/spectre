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
      // r15v2-①: 去重收紧为零误伤——v1 的归一前缀键(16/120 字符)在同
      // 靶场场景 5 例误吞不同漏洞+假成功回执(吞写比双账更危险, r15 实
      // 测撤回)。现仅三键全严: ①精确 title+severity(原逻辑) ②标题全串
      // 归一后完全相等(标点/大小写差异) ③同发现者 5 分钟内 detail 全串
      // 归一相等(重复提交)。跨 writer 相似标题不自动合并——由 writer
      // query_intel 纪律处置(平台已有惯例)。
      const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
      const normD = (t) => String(t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
      const nearEv = (ev, ms) => Date.now() - Date.parse(ev.ts ?? 0) < ms;
      const dup = [...this.events].reverse().find(e =>
        (e.type === 'vulnerability' || e.type === 'intel')
        && e.workSessionId === entry.workSessionId && !e.revises
        && ((e.title === entry.title && e.severity === entry.severity)
          || (norm(e.title) !== '' && norm(e.title) === norm(entry.title) && e.severity === entry.severity)
          || (e.from === entry.from && nearEv(e, 5 * 60_000)
            && normD(e.detail) !== '' && normD(e.detail) === normD(entry.detail))));
      if (dup) {
        dup.coDiscoverers = [...new Set([...(dup.coDiscoverers ?? []), entry.author?.name ?? entry.from].filter(Boolean))];
        return dup;
      }
    }
    // r28-#4(b): 落账后提示性二次扫描(裁决三护栏: 建议从不吞并/每对
    // 仅一次/双 seq+正本明示)——跨 writer 并发双账的零误伤补偿面。
    if (event.type === 'vulnerability' && !entry.revises) {
      const mySeq = event.seq;
      setTimeout(() => this.suggestDupMerge(mySeq), 10_000).unref?.();
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

  /** r29-#2: 落账前互斥预检——短窗(120s)内同项目同 severity 高重叠
   * vuln 存在则拦截(非吞并): 返回 {blocked, dupSeq} 由调用方回执指引
   * revise 并入。与 suggestDupMerge(事后提示)互补, 双保险。 */
  vulnMutexCheck(entry) {
    if (entry.type !== 'vulnerability' || entry.revises) return null;
    const tokens = t => new Set(String(t ?? '').toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fa5:/.]+/).filter(x => x.length > 2));
    const mt = tokens(`${entry.title} ${entry.detail ?? ''}`);
    if (mt.size < 4) return null;
    const cut = Date.now() - 120_000;
    for (const other of this.events) {
      if (other.type !== 'vulnerability' || other.revises
        || other.workSessionId !== entry.workSessionId
        || (other.severity ?? '') !== String(entry.severity ?? '')
        || Date.parse(other.ts ?? 0) < cut) continue;
      const ot = tokens(`${other.title} ${other.detail ?? ''}`);
      if (ot.size < 4) continue;
      let hit = 0;
      for (const t of ot) if (mt.has(t)) hit += 1;
      if (hit / Math.min(ot.size, mt.size) >= 0.7) {
        return { blocked: true, dupSeq: other.seq, dupTitle: other.title };
      }
    }
    return null;
  }

  /** r28-#4(b): 同点位双账建议——token 重叠>70% 且端点快检命中才提示,
   * 每对仅一次(查已有建议覆盖), 从不吞并(修订链由 writer 裁决)。 */
  suggestDupMerge(seq) {
    const me = this.events.find(e => e.seq === seq);
    if (!me || me.revises) return;
    const tokens = t => new Set(String(t ?? '').toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fa5:/.]+/).filter(x => x.length > 2));
    const mt = tokens(`${me.title} ${me.detail ?? ''}`);
    if (mt.size < 4) return;
    const cut = Date.now() - 10 * 60_000;
    for (const other of this.events) {
      if (other.seq === seq || other.type !== 'vulnerability' || other.revises
        || other.workSessionId !== me.workSessionId
        || (other.severity ?? '') !== (me.severity ?? '')
        || Date.parse(other.ts ?? 0) < cut) continue;
      const ot = tokens(`${other.title} ${other.detail ?? ''}`);
      let hit = 0;
      for (const t of ot) if (mt.has(t)) hit += 1;
      if (ot.size < 4 || hit / Math.min(ot.size, mt.size) < 0.7) continue;
      const pair = [seq, other.seq].sort((a, b) => a - b).join('+');
      const already = this.events.some(e => e.type === 'intel-note'
        && String(e.detail ?? '').includes(`重复对 ${pair}`));
      if (already) return;
      const primary = pair.split('+')[0];
      // 事件构造走与 emit 同一工厂(seq 自增)——_nextEvent 不存在时内联
      const dupEv = {
        channel: 'audit', from: 'system', type: 'intel-note',
        title: `疑似同点位双账建议(重复对 ${pair})`,
        summary: `漏洞 seq=${seq} 与 seq=${other.seq} 疑似同点位(token 重叠>70%)——建议经修订链合并, 正本=${primary}`,
        detail: `r28-#4(b) 提示性扫描: seq=${seq}/seq=${other.seq} 标题+正文 token 重叠超阈值。处理建议: 经 request_vulnerability_revision 将后到者并入先到者(正本=${primary}, 首落为正), 双发现者署名并入 coDiscoverers。本建议从不自动吞并(重复对 ${pair} 仅提示一次)。`,
        workSessionId: me.workSessionId ?? null,
      };
      dupEv.seq = ++seq; dupEv.ts = new Date().toISOString();
      this.events.push(dupEv);
      this._broadcast?.(dupEv);
      return;
    }
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
