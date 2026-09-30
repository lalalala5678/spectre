/** F67: bus journal 上限(5000)截断契约——确定性。
 * seq 单调续增 / list 封顶 / 修订孤儿在原事件被截后的折叠。 */
import { Bus } from '../src/bus.mjs';
import { foldRevisions } from '../src/revision.mjs';
import { nullWal, ck, finish } from './helpers.mjs';

const bus = new Bus(nullWal);
// 5001 条普通 + 原事件 + 修订(确保原事件恰好被截掉)
for (let i = 0; i < 5000; i++) {
  bus.emit({ channel: 'share', from: 'recon', summary: `fill-${i}` });
}
const orig = bus.emit({ channel: 'share', from: 'recon', type: 'intel', title: '截断边界', summary: 'orig' });
const rev = bus.emit({ channel: 'share', from: 'recon', type: 'intel', title: '截断边界(修订)', summary: 'rev', revises: orig.seq });

ck('list 封顶 5000', bus.list().length === 5000);
ck('最早事件 seq=3(前2条被截)', bus.list()[0].seq === 3);
ck('seq 单调续增', rev.seq === 5002);
ck('最新可达', bus.list().at(-1).seq === rev.seq);

// 修订孤儿前置条件: 原事件已不在 list, 修订事件仍在(前端 foldEntries
// 的孤儿分支消费此形态——前端行为已由浏览器实测覆盖)
for (let i = 0; i < 4999; i++) {
  bus.emit({ channel: 'share', from: 'recon', summary: `fill2-${i}` });
}
ck('二轮截断后封顶不变', bus.list().length === 5000)
ck('原事件已被截', !bus.list().some(e => e.seq === orig.seq));
ck('修订事件仍在', bus.list().some(e => e.seq === rev.seq && e.revises === orig.seq));

// R2-F2: 孤儿链现行版=最新修订(n 最大)——截断后 ≥2 修订, fold 应出 newest
const bus2 = new Bus(nullWal);
for (let i = 0; i < 5000; i++) {
  bus2.emit({ channel: 'share', from: 'recon', summary: `f-${i}` });
}
const o2 = bus2.emit({ channel: 'share', from: 'recon', type: 'intel', title: '孤儿链', summary: 'o' });
bus2.emit({ channel: 'share', from: 'recon', type: 'intel', title: '孤儿链r1', summary: 'r1', revises: o2.seq, revision: { n: 1 } });
bus2.emit({ channel: 'share', from: 'recon', type: 'intel', title: '孤儿链r2', summary: 'r2', revises: o2.seq, revision: { n: 2 } });
for (let i = 0; i < 4999; i++) {
  bus2.emit({ channel: 'share', from: 'recon', summary: `t-${i}` });
}
const folded2 = foldRevisions(bus2.list());
const orph2 = folded2.find(e => e.orphaned);
ck('孤儿现行版=最新修订', orph2?.current.title === '孤儿链r2', orph2?.current.title);
ck('孤儿计数=2', orph2?.revisedCount === 2);

finish();
