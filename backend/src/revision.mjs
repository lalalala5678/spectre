/**
 * Revision primitives — pure, shared by the tools layer (query folding),
 * the runtime caps (emission), and the offline test suite.
 *
 * Model: append-only. A revision is a NEW bus event carrying
 * `revises: <original seq>` + full replacement content + revision meta
 * {n, reason, requestedBy, approvedBy}. The original is never mutated;
 * the newest revision (max revision.n) is the CURRENT version.
 */

/**
 * Fold originals + their revision chains into current-view entries.
 * - revision events never stand alone EXCEPT orphans (their original was
 *   trimmed past the bus journal limit) — those surface standalone with
 *   `orphaned: true` so a trimmed head never silently hides the entry.
 */
export function foldRevisions(events) {
  const byOriginal = new Map(); // originalSeq -> newest revision event
  const counts = new Map();
  const knownSeqs = new Set(events.filter(e => !e.revises).map(e => e.seq));
  for (const e of events) {
    if (!e.revises) continue;
    const cur = byOriginal.get(e.revises);
    if (!cur || (e.revision?.n ?? 0) >= (cur.revision?.n ?? 0)) {
      byOriginal.set(e.revises, e);
    }
    counts.set(e.revises, Math.max(counts.get(e.revises) ?? 0, e.revision?.n ?? 0));
  }
  const folded = [];
  const seenOrphans = new Set();
  for (const e of events) {
    if (!e.revises) {
      folded.push({ ...e, current: byOriginal.get(e.seq) ?? e,
        revisedCount: counts.get(e.seq) ?? 0 });
      continue;
    }
    // revision: fold into its original — unless the original is gone
    if (knownSeqs.has(e.revises) || seenOrphans.has(e.revises)) continue;
    seenOrphans.add(e.revises);
    // R2-F2: 孤儿链的现行版=最新修订(n 最大)——此前取遍历序第一条
    // (最旧), 与文件头/query_intel 契约'newest is CURRENT'矛盾。
    const newest = byOriginal.get(e.revises) ?? e;
    folded.push({ ...newest, current: newest,
      revisedCount: counts.get(e.revises) ?? 0, orphaned: true });
  }
  return folded;
}

/**
 * Emit a revision event onto the bus. Field semantics: only provided
 * fields change; omitted fields inherit from the CURRENT version.
 * `void: true` marks the entry obsolete (downstream default-filtered).
 */
export function emitRevision(bus, { target, fields, reason,
  requestedBy, approvedBy, origin }) {
  const chain = bus.list().filter(e => e.revises === target.seq);
  const n = Math.max(0, ...chain.map(e => e.revision?.n ?? 0)) + 1;
  const current = chain.sort((a, b) =>
    (b.revision?.n ?? 0) - (a.revision?.n ?? 0))[0];
  const base = current ?? target;
  return bus.emit({
    channel: target.channel,
    from: target.from,
    to: target.to,
    type: target.type,
    revises: target.seq,
    title: fields.title ?? base.title,
    // F34: status/title 任一变更时重算 summary——此前沿用原串,
    // "failed · X" 修订为 success 后仍显示 failed(编排对账实测矛盾)
    summary: (fields.title !== undefined || fields.status !== undefined)
      ? `${fields.status !== undefined ? fields.status
          : (base.status ?? target.status ?? '')} · ${fields.title ?? base.title}`
      : (fields.title ?? base.summary),
    severity: fields.severity !== undefined ? fields.severity : base.severity,
    status: fields.status !== undefined ? fields.status : base.status,
    detail: fields.text ?? base.detail,
    void: fields.void !== undefined ? Boolean(fields.void)
      : Boolean(base.void),
    origin: origin ?? 'agent',
    author: target.author,
    workSessionId: target.workSessionId ?? null,
    engagement: target.engagement ?? null,
    payloadRef: target.payloadRef ?? null,
    requester: target.requester ?? null,
    revision: { n, reason: String(reason ?? ''), requestedBy: requestedBy ?? null,
      approvedBy: approvedBy ?? null },
  });
}
