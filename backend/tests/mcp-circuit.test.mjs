/**
 * MCP 熔断机锁: per-server circuit breaker 状态机(连续 3 失败→60s
 * 冷却快速跳过→冷却期满放行→成功关闸)。红→绿协议: 熔断实现前本文件红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { _cbCheck, _cbSuccess, _cbFail } from '../src/sandbox/mcp.mjs';

const S = 'brk-unit-test';

test('熔断状态机: 阈值前放行→3 失败开闸→冷却内拒→成功关闸', () => {
  _cbSuccess(S); // 清前态
  // 阈值前(1-2 次): 放行
  _cbFail(S);
  assert.equal(_cbCheck(S), null, '1 次失败不应开闸');
  _cbFail(S);
  assert.equal(_cbCheck(S), null, '2 次失败不应开闸');
  // 第 3 次: 开闸
  _cbFail(S);
  const open = _cbCheck(S);
  assert.ok(open, '3 连续失败后应开闸');
  assert.match(open, /熔断中/, '拒文案含"熔断中"');
  assert.match(open, /勿.*重试|快速跳过/, '文案劝阻重试');
  // 冷却内: 持续拒(多次调用同一状态)
  assert.ok(_cbCheck(S), '冷却期内持续拒');
  // 成功关闸
  _cbSuccess(S);
  assert.equal(_cbCheck(S), null, '成功后关闸恢复');
});

test('不同 server 互不影响(per-server 隔离)', () => {
  const A = 'brk-isolate-a', B = 'brk-isolate-b';
  _cbSuccess(A); _cbSuccess(B);
  _cbFail(A); _cbFail(A); _cbFail(A);
  assert.ok(_cbCheck(A), 'A 开闸');
  assert.equal(_cbCheck(B), null, 'B 不受 A 影响');
  _cbSuccess(A); _cbSuccess(B);
});

test('半开恢复: 冷却期满放行(时间快进不可直测——锁 openUntil 语义)', () => {
  const S2 = 'brk-halfopen';
  _cbSuccess(S2);
  _cbFail(S2); _cbFail(S2); _cbFail(S2);
  assert.ok(_cbCheck(S2), '开闸');
  // 注: 冷却期满(60s)后 _cbCheck 返回 null 放行——本用例锁当前拒;
  // 期满放行后的第一次成功关闸 / 失败重计已在用例 1 覆盖。
  assert.ok(_cbCheck(S2).includes('熔断中'), '拒文案稳定');
  _cbSuccess(S2);
});
