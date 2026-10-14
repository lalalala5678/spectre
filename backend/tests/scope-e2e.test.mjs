import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../src/bus.mjs';
import { emitScopeEntry } from '../src/scope.mjs';
import { buildIntelTools } from '../src/tools.mjs';

/** publish_scope → query_intel(kind=scope) 端到端链路机锁。
 * 批量审计(F1-1/F1-2/F1-3)三处断裂均处于 101 测试盲区——此文件补上:
 *  1. 真实 Bus 上首发不抛(bus.list 是方法非属性)
 *  2. kind=scope 只回资产条目(不混漏洞/报告)
 *  3. 同 target 再发走修订链, 现行版 detail 含新内容(fields.text 契约)
 *  4. 修订事件带 requestedBy 归因 */
test('publish_scope → query_intel kind=scope 端到端', async () => {
  const bus = new Bus();
  const caller = { id: 'a1', agentKey: 'recon', workSessionId: 'ws-scope-e2e' };
  const authorOf = () => ({ name: 'op', typeLabel: '指挥' });

  // 1. 首发不抛(F1-1: bus.list 曾被当属性取)
  const r1 = emitScopeEntry(bus, caller,
    { target: 'web.example.com', os: 'linux', ports: [{ port: 443, service: 'https' }] }, authorOf);
  assert.equal(r1.ok, true, '首发应成功');
  assert.equal(r1.revision, 0);

  // 干扰项: 同项目一条漏洞 + 一条任务报告
  bus.emit({ channel: 'share', from: 'nday', type: 'vulnerability',
    title: 'CVE-X', target: 'web.example.com', severity: 'high', detail: 'RCE',
    workSessionId: caller.workSessionId });
  bus.emit({ channel: 'share', from: 'report', type: 'task-report',
    title: '终报', status: 'ok', detail: 'x', workSessionId: caller.workSessionId });

  // 2. kind=scope 只回资产(F1-2: 曾归一为 task-report)
  const caps = { emitBus: () => ({}), listBus: () => bus.list(),
    authorOf: () => null, taskReportCount: 0 };
  const tools = buildIntelTools(caller, caps);
  const qi = tools.find(t => t.name === 'query_intel');
  assert.ok(qi, 'query_intel 应在工具列表');

  const resScope = await qi.execute('t', { kind: 'scope' });
  const txtScope = resScope.content.map(c => c.text ?? '').join('\n');
  assert.match(txtScope, /匹配 1 条/, 'kind=scope 只应匹配 1 条资产');
  assert.match(txtScope, /\[资产\|web\.example\.com\]/, '资产条目应有资产标签');
  assert.ok(!txtScope.includes('CVE-X'), '不应混入漏洞');
  assert.ok(!txtScope.includes('终报'), '不应混入任务报告');

  // kind=assets 别名同效
  const resAssets = await qi.execute('t', { kind: 'assets' });
  assert.match(resAssets.content.map(c => c.text ?? '').join('\n'), /\[资产\|/);

  // 3. 修订链: 同 target 再发 → seq 不变 rev+1, 现行版含新端口(F1-3: fields.detail 曾被忽略)
  const r2 = emitScopeEntry(bus, caller,
    { target: 'web.example.com', os: 'linux',
      ports: [{ port: 443, service: 'https' }, { port: 8080, service: 'http' }] }, authorOf);
  assert.equal(r2.ok, true, '修订应成功');
  assert.equal(r2.seq, r1.seq, '同 target upsert: seq 不变');
  assert.equal(r2.revision, 1, '修订号 +1');

  const revEvt = bus.list().find(e => e.type === 'scope' && e.revises === r1.seq);
  assert.ok(revEvt, '应产生 revises 指向原条的修订事件');
  assert.equal(revEvt.revision?.requestedBy, 'recon', '修订归因 requestedBy(F1-3 附带回归)');
  const revDetail = JSON.parse(revEvt.current?.detail ?? revEvt.detail);
  assert.ok(revDetail.ports.some(p => p.port === 8080),
    '修订事件现行版 detail 应含新端口 8080(fields.text 契约)');

  // seq 全文态: 取现行版
  const resSeq = await qi.execute('t', { seq: r1.seq });
  const txtSeq = resSeq.content.map(c => c.text ?? '').join('\n');
  assert.ok(txtSeq.includes('8080'), 'seq 全文应含最新修订内容');

  // 4. 跨项目: 他项目 scope 条目缺省不可见(F33 防火墙对 scope 同样生效)
  const otherCaller = { id: 'b1', agentKey: 'recon', workSessionId: 'ws-other' };
  const otherTools = buildIntelTools(otherCaller, caps);
  const qiOther = otherTools.find(t => t.name === 'query_intel');
  const resOther = await qiOther.execute('t', { kind: 'scope' });
  assert.match(resOther.content.map(c => c.text ?? '').join('\n'), /无匹配/,
    '他项目缺省查不到本项目资产');
});
