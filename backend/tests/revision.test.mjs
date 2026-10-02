/** Revision-system contract tests: folding, orphans, void, permissions,
 *  dedup exemption, dual-seq retrieval. Run: node --test tests/ */
import { buildIntelTools, buildChildTools, buildDirectTools } from '../src/tools.mjs';
import { makeWorld, ck, finish } from './helpers.mjs';

const { bus, store, makeCaps, emitRevision } = makeWorld();
const rec = store.create('recon', { workSessionId: 'ws' });
const caps = makeCaps(rec);
const [submit, query, , revise] = buildIntelTools(rec, caps);
const childCaps = { ...caps, spawnCheck: () => ({ ok: true }), spawnChild: () => ({ id: 'x' }) };

// ---------- direct revision (intel) ----------
const pi = buildChildTools(rec, childCaps).find(t => t.name === 'publish_intel');
await pi.execute('t', { title: '原版', text: '原文' });
const orig = bus.list().at(-1);
let t = (await revise.execute('t', { seq: orig.seq, reason: 'r1', title: '一版', text: 'A' })).content[0].text;
ck('intel 直接修订 n=1', t.includes('第 1 次修订'));
t = (await revise.execute('t', { seq: orig.seq, reason: 'r2', title: '二版' })).content[0].text;
ck('连续修订 n=2', t.includes('第 2 次修订'));

// ---------- folding ----------
t = (await query.execute('t', { kind: 'intel' })).content[0].text;
ck('列表现行版', t.includes('二版') && !t.includes('一版') && !t.includes('原版'));
ck('修订标记', t.includes('已修订2次'));
ck('计数不虚增', t.includes('匹配 1 条'));
t = (await query.execute('t', { seq: orig.seq })).content[0].text;
ck('原seq→现行版', t.includes('二版'));
const revSeq = bus.list().filter(e => e.revises === orig.seq).at(-1).seq;
t = (await query.execute('t', { seq: revSeq })).content[0].text;
ck('修订seq→现行版', t.includes('二版'));

// ---------- vulnerability permission gate ----------
bus.emit({ channel: 'dm', from: 'report', to: 'user', type: 'vulnerability',
  title: 'V1', severity: 'high', summary: 'V1', detail: 'd', workSessionId: 'ws' });
const vuln = bus.list().at(-1);
t = (await revise.execute('t', { seq: vuln.seq, reason: 'x', text: 'y' })).content[0].text;
ck('非writer改漏洞被拒+引导', t.includes('request_vulnerability_revision'));
const writer = store.create('report', { workSessionId: 'ws' });
writer.requester = { sessionId: rec.id, author: makeCaps(rec).authorOf(rec) };
const [, wQuery, , wRevise] = buildIntelTools(writer, makeCaps(writer));
t = (await wRevise.execute('t', { seq: vuln.seq, reason: 'writer 核定', severity: 'critical' })).content[0].text;
ck('writer 改漏洞通过', t.includes('第 1 次修订'));
t = (await wQuery.execute('t', { kind: 'vulnerability', severity: 'critical' })).content[0].text;
ck('severity 过滤看现行版', t.includes('V1'));

// ---------- dedup exemption ----------
const before = bus.list().length;
emitRevision(bus, { target: vuln, fields: { text: 'again' }, reason: 'r', origin: 'writer' });
ck('修订不被去重守卫吞掉', bus.list().length === before + 1);

// ---------- void semantics ----------
await wRevise.execute('t', { seq: orig.seq, reason: '情报过期', void: true });
t = (await query.execute('t', { kind: 'intel' })).content[0].text;
ck('作废后默认查询排除', t.includes('无匹配条目') && t.includes('情报 0 条'));
t = (await query.execute('t', { seq: orig.seq })).content[0].text;
ck('作废后 seq 检索可见+标记', t.includes('已作废'));

// ---------- task-report status revision ----------
await submit.execute('t', { title: 'R1', task: 't', actions: 'a', outcome: 'o', status: 'success' });
const rep = bus.list().filter(e => e.type === 'task-report').at(-1);
await wRevise.execute('t', { seq: rep.seq, reason: '更正', status: 'failed' });
t = (await query.execute('t', { kind: 'task-report', status: 'failed' })).content[0].text;
ck('status 过滤现行版', t.includes('R1'));

// ---------- requester attribution ----------
bus.emit({ channel: 'dm', from: 'report', to: 'user', type: 'vulnerability',
  title: 'V2', severity: 'low', summary: 'V2', workSessionId: 'ws',
  requester: { key: 'recon', name: '发现者甲', typeLabel: '资产测绘agent', treePath: 'p', depth: 1 } });
ck('requester 白名单透传', bus.list().at(-1).requester?.name === '发现者甲');

// ---------- tool sets ----------
const childNames = buildChildTools(rec, childCaps).map(x => x.name);
// CS81-F1: 恒真 || true 删——机锁此前失效(revise_entry 不入 child 集
// 全仓无有效锁); 三子句现况均真, 删后即真锁。
ck('child 集含委托+申请+修订(不含 revise_entry)', childNames.includes('report_vulnerability')
  && childNames.includes('request_vulnerability_revision')
  && childNames.includes('revise_entry') === false);  // revise_entry 在 intel 集(矩阵拼接)
const directNames = buildDirectTools(store.create('recon', { workSessionId: 'ws2' }), makeCaps(rec)).map(x => x.name);
ck('direct 非report=委托版', directNames.includes('report_vulnerability') && !directNames.includes('publish_vulnerability'));
const wNames = buildDirectTools(store.create('report', { workSessionId: 'ws2' }), makeCaps(writer)).map(x => x.name);
ck('report 会话=落账版', wNames.includes('publish_vulnerability') && !wNames.includes('report_vulnerability'));

finish();
