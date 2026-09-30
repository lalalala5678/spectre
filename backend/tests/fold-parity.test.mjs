/**
 * fold-parity (CS1-R20/CS6-F7): 修订折叠黄金样本——backend foldRevisions
 * 与 console foldEntries 两侧注释互指互认"同实现"; 本夹具固化同一组
 * 事件 → 期望折叠输出, console 侧改动须同步样本(样本即契约)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { foldRevisions } from '../src/revision.mjs';

const events = [
  { seq: 1, type: 'intel', title: '初版', summary: null, workSessionId: 'ws-a' },
  { seq: 2, type: 'task-report', title: '报告甲', summary: null, workSessionId: 'ws-a' },
  { seq: 3, type: 'intel', revises: 1, revision: { n: 1 },
    title: '修订一', summary: null, workSessionId: 'ws-a' },
  { seq: 4, type: 'intel', revises: 1, revision: { n: 2 },
    title: '修订二', summary: null, workSessionId: 'ws-a' },
  { seq: 5, type: 'intel', revises: 99, revision: { n: 1 },
    title: '悬空修订', summary: null, workSessionId: 'ws-a' },
];

test('折叠保留原始条目+独立条目, 修订并入原链', () => {
  const folded = foldRevisions(events);
  assert.equal(folded.filter(e => e.seq === 1 || e.seq === 2).length, 2);
});

test('现行版=修订链上 revision.n 最大者', () => {
  const bySeq = Object.fromEntries(foldRevisions(events).map(e => [e.seq, e]));
  assert.equal(bySeq[1].current.title, '修订二');
  assert.equal(bySeq[1].revisedCount, 2);
});

test('悬空修订(原条目不在窗口内)自成一格', () => {
  assert.ok(foldRevisions(events).some(e => e.seq === 5 && e.title === '悬空修订'));
});

test('无关类型不折叠', () => {
  const bySeq = Object.fromEntries(foldRevisions(events).map(e => [e.seq, e]));
  assert.equal(bySeq[2].title, '报告甲');
  assert.equal(bySeq[2].revisedCount ?? 0, 0);
});
