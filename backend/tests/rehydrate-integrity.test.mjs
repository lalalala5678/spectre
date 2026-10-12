/**
 * 2026-10-11 回归测试(防线③): rehydrate 重建完整性——
 * 事故背景: record 构造时 spread 链丢 `...shell` 导致 40 会话→1 个
 * (id=undefined 互相覆盖), 项目里所有会话消失, 静默 3 小时。
 * 本测试断言: ①数量守恒 ②壳字段(id/agentKey/workSessionId/title)
 * 逐字段等于 shell ③壳字段不依赖 spread 链(显式兜底路径也在测)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/sessions.mjs';

function fixture(n) {
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push({
      shell: {
        id: `sess-fixture-${i}`,
        agentKey: i % 2 ? 'autopwn' : 'recon',
        workSessionId: `ws-fixture-${i % 3}`,
        createdAt: Date.now() - i * 1000,
        title: `会话${i}`,
      },
      messages: [{ role: 'user', content: `hello ${i}` }],
      meta: { lastActivityTs: Date.now() - i * 500 },
    });
  }
  return items;
}

test('rehydrate: 数量守恒 + 壳字段逐字段完整(…shell 丢失事故回归)', () => {
  const items = fixture(40);
  const store = new SessionStore({
    model: {}, streamFn: () => {}, modelForAgent: () => ({}), caps: {}, wal: {},
    summarizer: { },
  });
  store.rehydrate(items);
  assert.equal(store.sessions.size, 40, '重建数必须等于输入数(事故时 40→1)');
  for (const it of items) {
    const s = store.sessions.get(it.shell.id);
    assert.ok(s, `会话 ${it.shell.id} 必须存在`);
    assert.equal(s.id, it.shell.id, 'id 必须等于 shell.id');
    assert.equal(s.agentKey, it.shell.agentKey, 'agentKey 必须等于 shell.agentKey');
    assert.equal(s.workSessionId, it.shell.workSessionId, 'workSessionId 必须等于 shell.workSessionId');
  }
});

test('rehydrate: 显式壳兜底路径(spread 链被破坏时仍不丢壳)', () => {
  // 模拟 meta 携带全部壳字段而 shell 仍在(覆盖顺序 meta 优先)——
  // 以及 shell.id 兜底 meta 缺失的组合。
  const items = [{
    shell: { id: 'sess-a', agentKey: 'exploit', workSessionId: 'ws-1', createdAt: 123 },
    messages: [],
    meta: {},
  }, {
    shell: { id: 'sess-b', agentKey: 'nday' },
    messages: [],
    meta: { workSessionId: 'ws-2' },
  }];
  const store = new SessionStore({
    model: {}, streamFn: () => {}, modelForAgent: () => ({}), caps: {}, wal: {},
    summarizer: {},
  });
  store.rehydrate(items);
  assert.equal(store.sessions.size, 2);
  assert.equal(store.sessions.get('sess-a').workSessionId, 'ws-1', 'shell 字段直接透传');
  assert.equal(store.sessions.get('sess-b').workSessionId, 'ws-2', 'meta 优先于 shell');
  assert.equal(store.sessions.get('sess-b').id, 'sess-b');
});

test('rehydrate: 同 id 多次快照去重(数量守恒的输入形态)', () => {
  const items = [
    { shell: { id: 'sess-x', agentKey: 'api' }, messages: [], meta: {} },
    { shell: { id: 'sess-x', agentKey: 'api' }, messages: [{ role: 'user', content: 'm2' }], meta: {} },
  ];
  const store = new SessionStore({
    model: {}, streamFn: () => {}, modelForAgent: () => ({}), caps: {}, wal: {},
    summarizer: {},
  });
  store.rehydrate(items);
  assert.equal(store.sessions.size, 1, '同 id 快照合并为一个会话');
});
