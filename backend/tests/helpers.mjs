/**
 * Shared test scaffolding — in-memory store + fake streamFn + caps with
 * PRODUCTION revision logic (src/revision.mjs), so the suite exercises
 * the real folding/emission code paths.
 */
import { SessionStore } from '../src/sessions.mjs';
import { Bus } from '../src/bus.mjs';
import { emitRevision } from '../src/revision.mjs';
import { entryKind } from '../src/tools.mjs';

export const idleStream = () => ({
  async *[Symbol.asyncIterator]() {},
  async result() { return { role: 'assistant', content: [] }; },
});

export const nullWal = {
  append: () => {}, readAll: () => ({ entries: [], truncated: false }),
  compact: () => {}, close: () => {},
};

export const authorOf = rec => ({
  key: rec.agentKey, name: rec.spawnName ?? rec.agentKey,
  typeLabel: rec.agentKey, treePath: rec.agentKey, depth: 0, sessionId: rec.id,
});

export function makeWorld() {
  const bus = new Bus(nullWal);
  const store = new SessionStore({
    model: { id: 'test', api: 'oc' }, streamFn: idleStream,
    caps: {}, wal: nullWal,
  });
  const makeCaps = _rec => ({
    followUp: () => {},
    emitBus: e => bus.emit(e),
    listBus: () => bus.list(),
    authorOf,
    // production-shape reviseEntry (mirrors agent-runtime caps; the
    // emitRevision core is the SHARED src/revision.mjs implementation)
    reviseEntry: (callerRecord, params) => {
      const target = bus.list().find(e => e.seq === Number(params.seq) && !e.revises);
      if (!target) return { text: `seq=${params.seq} 不存在` };
      if (entryKind(target) === 'vulnerability' && callerRecord.agentKey !== 'report') {
        return { text: '漏洞修订须走 request_vulnerability_revision' };
      }
      const a = authorOf(callerRecord);
      const event = emitRevision(bus, {
        target, fields: params, reason: params.reason,
        requestedBy: callerRecord.requester?.author ?? a, approvedBy: a,
        origin: callerRecord.agentKey === 'report' ? 'writer' : 'agent',
      });
      return { text: `修订已入库(seq=${target.seq} 第 ${event.revision.n} 次修订)` };
    },
  });
  return { bus, store, makeCaps, emitRevision };
}

export let pass = 0;
export let fail = 0;
export const ck = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok ? '' : ' -> ' + String(detail).slice(0, 120)}`);
  if (ok) pass++; else fail++;  // CS3: no-unused-expressions
};
export const finish = () => {
  console.log(`${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
};
