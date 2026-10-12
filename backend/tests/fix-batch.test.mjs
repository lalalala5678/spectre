/**
 * 复盘修复批测试: ①vuln-draft 编写中占位(query_intel 可见/终局消隐)
 * ②request_authorization 多目标+子网覆盖去重 ③A4 判定行(静态断言)。
 */
import { ck, finish, makeWorld, authorOf } from './helpers.mjs';
import { buildIntelTools } from '../src/tools.mjs';

const { bus, makeCaps } = makeWorld();
const rec = { agentKey: 'autopwn', spawnName: 'tester', id: 'sess-t', workSessionId: 'ws1' };
const caps = makeCaps(rec);
const tools = buildIntelTools(rec, caps);
const queryIntel = tools.find(t => t.name === 'query_intel');

// ── ① vuln-draft 占位 ──
bus.emit({ channel: 'share', from: 'report', type: 'vuln-draft',
  title: '[编写中] 报告:靶机 RCE 线索',
  summary: '漏洞线索正在撰写中——撰写申请由 tester(autopwn)提交',
  requester: 'tester', payloadRef: 'sess:w1', workSessionId: 'ws1' });

let r = await queryIntel.execute('t', { kind: 'vulnerability' });
let txt = r.content[0].text;
ck('draft 在飞→可见(库空走空态文案/库非空走计数行)',
  txt.includes('[编写中]') && txt.includes('靶机 RCE 线索') && txt.includes('tester')
  && (txt.includes('另有编写中 1 条') || txt.includes('1 条报告正在编写中')), txt.slice(0, 160));
ck('draft 只见标题不见正文正文形态(无 severity 冒充)', !/\[seq=\d+\]\[漏洞\|[a-z]+\].*编写中/.test(txt), '');

// resolve 后消隐
const dEv = bus.list().find(e => e.type === 'vuln-draft');
bus.emit({ channel: 'audit', from: 'report', type: 'vuln-draft',
  resolves: dEv.seq, status: 'published', workSessionId: 'ws1' });
bus.emit({ channel: 'share', from: 'report', type: 'vulnerability',
  title: '靶机 RCE', severity: 'critical', detail: 'x'.repeat(50),
  workSessionId: 'ws1', author: authorOf(rec) });
r = await queryIntel.execute('t', { kind: 'vulnerability' });
txt = r.content[0].text;
ck('draft resolve→消隐, 正式条目在列', !txt.includes('[编写中]') && txt.includes('靶机 RCE'), txt.slice(0, 120));

// ── ② request_authorization 多目标+子网覆盖 ──
let seq = 9900; const pend = [];
// (2026-10-12: request_authorization 工具已随授权机制移除, 对应测试段删除)

finish();
