/** r29-#2: writer 落账互斥——vulnMutexCheck 短窗拦截契约(确定性)。
 * 同项目同 severity 且 title+detail token 重叠≥70% 且 120s 窗内 → blocked;
 * 跨项目 / 不同 severity / 修订版 / 低重叠 → 放行(null)。零吞并:
 * 拦截只返回指引, 库内不落任何事件。 */
import { Bus } from '../src/bus.mjs';
import { nullWal, ck, finish } from './helpers.mjs';

const bus = new Bus(nullWal);
const base = {
  channel: 'dm', from: 'report', to: 'user', type: 'vulnerability',
  severity: 'high', title: 'Range29 /api/v1/users IDOR 越权访问',
  detail: '发现过程: api 席矩阵验证 /api/v1/users?id= 任意读, POC: curl -H auth 1..999, 危害: 全量用户数据',
  workSessionId: 'ws-a',
};
const first = bus.emit({ ...base });
ck('首落放行', first.seq > 0);

// 同点位第二 writer → 拦截
const block = bus.vulnMutexCheck({ ...base, title: base.title + ' (复检)' });
ck('高重叠拦截', block?.blocked === true);
ck('dupSeq 指向首落', block.dupSeq === first.seq);
ck('拦截不落账', bus.list().length === 1);

// 跨项目放行
ck('跨项目放行', bus.vulnMutexCheck({ ...base, workSessionId: 'ws-b' }) === null);
// 不同 severity 放行
ck('不同 severity 放行', bus.vulnMutexCheck({ ...base, severity: 'critical' }) === null);
// 修订版放行
ck('修订版放行', bus.vulnMutexCheck({ ...base, revises: first.seq }) === null);
// 低重叠(不同漏洞)放行
ck('低重叠放行', bus.vulnMutexCheck({
  ...base, title: 'Range29 SSH 弱口令 root/123456',
  detail: 'weakcred 席爆破命中, POC: sshpass ssh root@target, 危害: 主机沦陷',
}) === null);

// 窗外放行: 手工把首落 ts 拨回 3 分钟前
const old = bus.events.find(e => e.seq === first.seq);
old.ts = new Date(Date.now() - 181_000).toISOString();
ck('120s 窗外放行', bus.vulnMutexCheck({ ...base }) === null);

// 窗外+内容演进 → 真入库(既有 detail 全等幂等仍守: 同文重发返回 dup)
const second = bus.emit({ ...base, title: base.title + ' (窗口外)',
  detail: base.detail + '; 复检补证: 新增 999 号租户命中' });
ck('窗口外演进版正常入库', second.seq > first.seq);
const dupAgain = bus.emit({ ...base, title: base.title + ' (窗口外)',
  detail: base.detail + '; 复检补证: 新增 999 号租户命中' });
ck('同文重发幂等返回原 seq', dupAgain.seq === second.seq);

finish();
