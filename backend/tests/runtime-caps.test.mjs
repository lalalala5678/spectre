/** R32D85-E1(P1) 回归锁: caps 通路 textOf 必传 m.content。
 * 背景: cb381c5 重构后三处传整消息对象 → read_session 恒'(无文本)'、
 * wake_agent 恒败、驳回转述恒'(无输出)'; 56 测/7 测均未覆盖 caps 通路
 * (agent-runtime 顶层装配重型依赖, 无法单测实例化), 故以结构锁护住
 * 该回归类(同 twin-parity 对 ARCHITECTURE 行数表的结构锁先例)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'agent-runtime.mjs'), 'utf8');

test('caps 通路 textOf 收 content 非整消息(R32D85-E1 锁)', () => {
  const uses = src.match(/textOf\((?:m|last)\.content\)/g) ?? [];
  assert.ok(uses.length >= 3, `textOf(m.content) 须>=3 处(lastReply×2+readSessionMessages), 实得 ${uses.length}`);
  assert.ok(!/textOf\((?:m|last)\)/.test(src), '不得再出现 textOf(整消息对象)——恒空串死读');
});
