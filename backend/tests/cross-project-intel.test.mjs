/**
 * 跨项目记忆机锁: query_intel scope='all' 只读索引面。
 *
 * F33(项目作用域)是防火墙, 本面开的是**索引窗**: scope='all' 跨项目可
 * 检索标题/摘要(第 53 所学校命中"WebVPN 默认密钥族"类模式), 但全文/
 * 修订仍按项目边界。红→绿协议: scope 参数实现前本文件红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIntelTools } from '../src/tools.mjs';
import { Bus } from '../src/bus.mjs';
import { nullWal } from './helpers.mjs';

const recA = { id: 'sess-a', agentKey: 'recon', workSessionId: 'ws-a', taskReportCount: 0 };
const recB = { id: 'sess-b', agentKey: 'nday', workSessionId: 'ws-b', taskReportCount: 0 };

/** 项目 A 沉淀(WebVPN 先例+长正文) + 项目 B 一条自有条目。 */
function world() {
  const bus = new Bus(nullWal);
  bus.emit({ channel: 'share', from: 'recon', type: 'intel-note',
    title: 'WebVPN 出厂默认密钥族(跨校同族互证)', summary: '同族默认值',
    detail: 'SECRET-CRED-MAIN ' + '正文填充'.repeat(100), workSessionId: 'ws-a' });
  bus.emit({ channel: 'share', from: 'weakcred', type: 'vulnerability',
    title: '某校统一认证弱口令', severity: 'high', summary: 'weakpass',
    detail: '正文在项目 A…', workSessionId: 'ws-a' });
  const evOwn = bus.emit({ channel: 'share', from: 'nday', type: 'intel-note',
    title: 'B项目自有条目', summary: 'own', detail: 'OWN-DETAIL-OK',
    workSessionId: 'ws-b' });
  return { bus, evOwn };
}

async function runQuery(params, who = 'b') {
  const { bus } = world();
  const caps = {
    emitBus: e => bus.emit(e),
    listBus: () => bus.list(),
    authorOf: () => ({ key: 'nday', name: 'nday', typeLabel: 'nday' }),
  };
  const qi = buildIntelTools(who === 'b' ? recB : recA, caps).find(t => t.name === 'query_intel');
  const out = await qi.execute('i', params);
  return out.content[0].text;
}

test("scope 缺省=现状(F33): 项目 B 查不到项目 A 的条目", async () => {
  const r = await runQuery({ kind: 'intel' });
  assert.match(r, /无匹配条目|B项目自有条目/, '缺省 scope 只见本项目');
  assert.ok(!r.includes('WebVPN'), `缺省 scope 不得跨项目, 实得: ${r.slice(0, 120)}`);
});

test("scope='all': 命中带 ws 标记+索引面声明, 且正文不泄漏只出摘要", async () => {
  const r = await runQuery({ scope: 'all', q: 'webvpn' });
  assert.match(r, /WebVPN 出厂默认密钥族/, '跨项目 q 命中(标题/摘要面)');
  assert.match(r, /ws-a/, '命中行须带来源 ws 标记');
  assert.match(r, /索引面/, '回执须声明跨项目索引面');
  assert.ok(!r.includes('SECRET-CRED'), 'foreign 正文(detail)不得泄漏');
  assert.ok(r.includes('同族默认值'), 'foreign 摘要(summary)可见(索引面契约)');
});

test("scope='all' 检索面=标题/摘要: q 命中他项目 detail 关键词不应命中", async () => {
  const r = await runQuery({ scope: 'all', q: 'secret-cred-main' });
  assert.ok(!r.includes('WebVPN'), '他项目 detail 内容不进跨项目检索面');
});

test("scope='all' + seq: 本项目放行全文, 他项目拒绝且不泄正文", async () => {
  const { bus, evOwn } = world();
  const evForeign = bus.list().find(e => e.title?.includes('WebVPN'));
  const caps = { emitBus: e => bus.emit(e), listBus: () => bus.list(),
    authorOf: () => ({ key: 'nday', name: 'nday', typeLabel: 'nday' }) };
  const qi = buildIntelTools(recB, caps).find(t => t.name === 'query_intel');
  const own = await qi.execute('i', { scope: 'all', seq: evOwn.seq });
  assert.ok(own.content[0].text.includes('OWN-DETAIL-OK'),
    '本项目 seq 在 scope=all 下必须放行全文(不得谎称"属于他项目")');
  const foreign = await qi.execute('i', { scope: 'all', seq: evForeign.seq });
  const ft = foreign.content[0].text;
  assert.match(ft, /他项目/, '他项目 seq 拒绝并指引');
  assert.ok(!ft.includes('SECRET-CRED'), '拒绝回执不得带他项目正文');
});

test("scope='all' 空结果诊断: 计数是本项目的, 不冒称全库", async () => {
  const r = await runQuery({ scope: 'all', q: 'zzz-nope' });
  assert.match(r, /情报 1 条/, '本项目自有情报 1 条(B项目自有条目)');
  assert.ok(!r.includes('弱口令'), '他项目条目不计入"当前项目内"计数');
});

test("scope='all' 不弱化修订墙: reviseEntry 跨项目仍拒(F33 回归)", async () => {
  const { bus } = world();
  const evA = bus.list().find(e => e.title?.includes('WebVPN'));
  const caps = { emitBus: e => bus.emit(e), listBus: () => bus.list(),
    authorOf: () => ({ key: 'nday', name: 'nday', typeLabel: 'nday' }),
    reviseEntry: (caller, params) => {
      const target = bus.list().find(e => e.seq === Number(params.seq)
        && e.workSessionId === (caller.workSessionId ?? null));
      return { text: target ? '修订已入库' : `seq=${params.seq} 不在本项目可修订范围` };
    } };
  const rev = buildIntelTools(recB, caps).find(t => t.name === 'revise_entry');
  const out = await rev.execute('i', { seq: evA.seq, reason: 'x', title: '改' });
  assert.match(out.content[0].text, /不在本项目可修订范围/, '跨项目修订必须保持拒绝');
});
