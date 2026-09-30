/**
 * fold-parity.test.mjs (CS1-R20): 修订折叠的跨语言契约夹具——backend
 * foldRevisions 与 console foldEntries 两侧注释互指互认"同实现", 但
 * 无共享断言, R2-F2 类单侧修复曾让两侧漂移。本夹具固化同一组事件
 * → 期望折叠输出的黄金样本; console 侧(tsc 工程)无法直接跑此文件,
 * 改动 foldEntries 时必须把同一样本同步进两侧(样本即契约)。
 */
import { foldRevisions } from '../src/revision.mjs';
import { finish } from './helpers.mjs';

// 黄金样本(原始事件 + 一次修订 + 二次修订 + 悬空修订 + 任务报告)
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

const folded = foldRevisions(events);
const bySeq = Object.fromEntries(folded.map(e => [e.seq, e]));

ck('折叠保留原始条目+独立条目, 修订并入原链',
  folded.filter(e => e.seq === 1 || e.seq === 2).length === 2);
ck('现行版=修订链上 revision.n 最大者',
  bySeq[1]?.title === '修订二' && bySeq[1]?.revisedCount === 2);
ck('悬空修订(原条目不在窗口内)自成一格',
  folded.some(e => e.seq === 5 && e.title === '悬空修订'));
ck('无关类型不折叠',
  bySeq[2]?.title === '报告甲' && !bySeq[2]?.revisedCount);

function ck(label, ok) {
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${label}`);
  if (!ok) process.exitCode = 1;
}
finish();

