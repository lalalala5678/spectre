/**
 * 2026-10-12 紧急消息/查重门 回归测试:
 * ①urgentSteer 状态机(空闲直达 / 忙时入队+abort+回合收尾注入 / 防递归只排队)
 * ②publish_vulnerability 机械查重门(同资产同词重合命中回执 / [已比对标记放行 /
 *   不同资产不拦)
 * ③query_intel payloadRef/requester 可检索 + draft 时间戳展示
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/sessions.mjs';
import { buildIntelTools, vulnDedupGate, dupReceipt } from '../src/tools.mjs';

// ── fixtures(参照 rehydrate-integrity.test.mjs 的最小构造方式) ──
function fakeAgent() {
  return {
    state: { isStreaming: false, messages: [] },
    aborted: 0,
    prompts: [],
    abort() { this.aborted += 1; },
    prompt(msg) { this.prompts.push(msg); return Promise.resolve(); },
    steer() { /* 空闲直达路径不会走到 */ },
  };
}
function fakeRecord(over = {}) {
  return {
    id: 'sess-urg-1', agentKey: 'recon', workSessionId: 'ws-1',
    busy: false, turnStartedAt: null, events: [], completionWaiters: [],
    clients: new Set(), summarizeBusy: false, taskReportCount: 0,
    agent: fakeAgent(),
    ...over,
  };
}

function newStore() {
  return new SessionStore({
    model: {}, streamFn: () => {}, modelForAgent: () => ({}),
    caps: {}, wal: {}, summarizer: {},
  });
}

// ── ① urgentSteer 状态机 ─────────────────────────────────────────

test('urgentSteer: 空闲会话直达 prompt(不打断、无队列)', async () => {
  const store = newStore();
  const rec = fakeRecord();
  store.sessions.set(rec.id, rec);
  store.urgentSteer(rec, '紧急通报', 'agent');
  await new Promise(r => setImmediate(r));  // prompt 经 _maybeCompact finally 异步派发
  assert.equal(rec.agent.prompts.length, 1, '空闲时立即注入一个回合');
  assert.equal(rec.agent.prompts[0].content ?? rec.agent.prompts[0], '紧急通报', '空闲直达保留原文, 不加打断头');
  assert.equal(rec.agent.aborted, 0, '空闲时不 abort');
  assert.ok(!rec.urgentQueue?.length, '不入队');
});

test('urgentSteer: 忙时入队 + abort + 回合收尾(agent_end)自动注入', async () => {
  const store = newStore();
  const rec = fakeRecord();
  store.sessions.set(rec.id, rec);
  rec.busy = true;
  rec.turnStartedAt = Date.now() - 1000;
  rec.agent.state.isStreaming = true;

  store.urgentSteer(rec, 'U1 重复报告协调', 'agent');
  assert.equal(rec.urgentQueue.length, 1, '消息入紧急队列');
  assert.equal(rec.agent.aborted, 1, '在飞回合被打断(abort 恰一次)');
  assert.ok(rec.events.some(e => e.type === 'urgent_queued'), 'journal 记录 urgent_queued');

  // 模拟回合收尾: pi abort → agent_end → busy 翻 false → pump 注入
  rec.agent.state.isStreaming = false;
  store._onAgentEvent(rec, { type: 'agent_end' });
  await new Promise(r => setImmediate(r));  // prompt 经 _maybeCompact finally 异步派发
  assert.equal(rec.agent.prompts.length, 1, '收尾处自动开一个紧急处理回合');
  const injected = String(rec.agent.prompts[0].content ?? rec.agent.prompts[0]);
  assert.ok(injected.startsWith('[紧急·打断]'), '注入以 [紧急·打断] 头标记');
  assert.ok(injected.includes('U1 重复报告协调'), '排队消息并入注入文本');
  assert.ok(injected.includes('继续你被打断的工作'), '注入含续原工作指令');
  assert.equal(rec.urgentQueue.length, 0, '队列清空');
  assert.equal(rec.busy, true, '紧急处理回合占住 busy(新回合已开)');
  assert.equal(rec._urgentTurn, true, '本回合标记为紧急处理回合');
});

test('urgentSteer: 防递归——紧急处理回合内再收 urgent 只排队不 abort', () => {
  const store = newStore();
  const rec = fakeRecord();
  store.sessions.set(rec.id, rec);
  rec.busy = true;
  rec._urgentTurn = true;  // 当前回合=紧急处理回合
  store.urgentSteer(rec, '第二条紧急', 'agent');
  assert.equal(rec.urgentQueue.length, 1, '只入队');
  assert.equal(rec.agent.aborted, 0, '不再打断紧急处理回合本身');
  assert.equal(rec.agent.prompts.length, 0, '不即时注入');
});

// ── ② 机械查重门 ─────────────────────────────────────────────────

const WS = 'ws-dedup';
const busEvents = () => [
  { seq: 10, type: 'vulnerability', workSessionId: WS,
    title: 'A大学教务系统 SQL注入', detail: 'target: jw.a.edu.cn/api/users 参数可注入',
    severity: 'high', payloadRef: 'sess:sess-w1', ts: '2026-10-12T01:00:00Z' },
  { seq: 11, type: 'vuln-draft', workSessionId: WS,
    title: 'A大学教务系统越权访问', detail: 'jw.a.edu.cn/api/orders 可越权查单',
    requester: 'recon一号', payloadRef: 'sess:sess-w2', ts: '2026-10-12T02:00:00Z' },
  // 不同资产的同型漏洞: 不应被拦
  { seq: 12, type: 'vulnerability', workSessionId: WS,
    title: 'B大学教务系统 SQL注入', detail: 'target: jw.b.edu.cn/api/users 参数可注入',
    severity: 'critical', payloadRef: 'sess:sess-w3', ts: '2026-10-12T03:00:00Z' },
];

test('查重门: 同资产+标题实质词重合≥3 → 命中并返回回执', () => {
  const gate = vulnDedupGate(busEvents(), {
    title: 'A大学教务系统注入漏洞', detail: 'jw.a.edu.cn /api/users 注入点复测' });
  assert.ok(gate, '同资产(jw.a.edu.cn)+标题词重合应命中');
  assert.equal(gate.landed.length, 1, '命中已落账 seq=10');
  assert.equal(gate.drafts.length, 1, '保守比对(宁误拦不漏): draft 标题词亦重合, 一并进回执');
  const text = dupReceipt(gate);
  assert.ok(text.startsWith('疑似重复(平台机械比对命中):'), '回执头');
  assert.ok(text.includes('seq=10'), '回执含已落账 seq');
  assert.ok(text.includes('[high]'), '回执含定级');
  assert.ok(text.includes('【处理规则(必读)】'), '回执含处理规则');
  assert.ok(text.includes('relay_to_agents(urgent=true)'), '规则指引紧急消息通道');
});

test('查重门: 同资产+端点路径相同 → 命中(词重合不足时兜底)', () => {
  const gate = vulnDedupGate(busEvents(), {
    title: '完全不同的措辞 XYZ', detail: 'jw.a.edu.cn/api/orders 越权' });
  assert.ok(gate, '端点 /api/orders 与 draft 相同应命中');
  assert.equal(gate.drafts.length, 1, '命中编写中条目');
  const text = dupReceipt(gate);
  assert.ok(text.includes('requester=recon一号'), '回执含上报者');
  assert.ok(text.includes('2026-10-12 02:00'), '回执含上报时间戳');
  assert.ok(text.includes('payloadRef=sess:sess-w2'), '回执含对方 writer 会话定位');
});

test('查重门: 不同资产不拦; [已比对 标记放行', () => {
  assert.equal(vulnDedupGate(busEvents(), {
    title: 'B大学门户 SQL注入', detail: 'portal.b2.edu.cn /api/q 注入' }), null,
  '与库内任何条目资产不重合 → 放行');
  assert.equal(vulnDedupGate(busEvents(), {
    title: 'A大学教务系统 SQL注入(复测)', detail: 'jw.a.edu.cn/api/users',
    hint: "已比对, 对方确认不同[已比对 seq=10/编写中条目, 判定: 不同漏洞, 理由: 参数不同]" }), null,
  'hint 带 [已比对 标记 → 跳过机械门直接放行');
});

// ── ③ query_intel payloadRef/requester 可检索 + draft 时间戳 ─────

test('query_intel: q 搜 payloadRef 命中条目; draft 行含 requester/时间戳', async () => {
  const tools = buildIntelTools(
    { agentKey: 'recon', workSessionId: WS },
    { listBus: () => busEvents() });
  const qi = tools.find(t => t.name === 'query_intel');

  const byRef = await qi.execute(undefined, { q: 'sess-w1' });
  assert.ok(byRef.content[0].text.includes('seq=10'), '搜 payloadRef 片段命中对应条目');

  const byReq = await qi.execute(undefined, { kind: 'vulnerability' });
  assert.ok(byReq.content[0].text.includes('编写中'), '编写中占位可见');
  assert.ok(byReq.content[0].text.includes('recon一号'), 'draft 行含 requester');
  assert.ok(byReq.content[0].text.includes('2026-10-12 02:00'), 'draft 行含上报时间戳');
  assert.ok(byReq.content[0].text.includes('payloadRef=sess:sess-w2'), 'draft 行含 payloadRef');
});
