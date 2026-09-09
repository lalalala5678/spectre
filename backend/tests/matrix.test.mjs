/** Tool-matrix + dynamic-prompt + quota contract tests. */
import { buildChildTools, buildOrchestratorTools } from '../src/tools.mjs';
import { makeWorld, ck, finish } from './helpers.mjs';

const { store, makeCaps } = makeWorld();
const caps = makeCaps(store.create('recon', { workSessionId: 'ws' }));
const childCaps = { ...caps, spawnCheck: () => ({ ok: true }), spawnChild: () => ({ id: 'x' }) };

// ---------- spawn enum excludes report ----------
const spawn = buildChildTools(store.create('recon', { workSessionId: 'ws' }), childCaps)
  .find(t => t.name === 'spawn_agent');
const literals = JSON.stringify(spawn.parameters.properties.agentKey?.anyOf
  ?? spawn.parameters.properties.agentKey);
ck('spawn 枚举无 report', !literals.includes('"report"') && literals.includes('"recon"'));

// ---------- dispatch enum keeps report (user decision pending) ----------
const dispatch = buildOrchestratorTools(store.create('autopwn', { workSessionId: 'ws' }), caps)
  .find(t => t.name === 'dispatch_agents');
ck('dispatch 枚举含 report(现状)', JSON.stringify(dispatch.parameters.properties.agents).includes('"report"'));

// ---------- orchestrator tool face (regression: no output tools) ----------
const orch = store.create('autopwn', { workSessionId: 'ws' });
// _buildAgent matrix: orchestrator = orch tools + child outputs (minus spawn) + intel
const built = orch.agent.state.tools.map(t => t.name);
ck('编排器持有 report_vulnerability', built.includes('report_vulnerability'));
ck('编排器持有 publish_intel', built.includes('publish_intel'));
ck('编排器持有 request_vulnerability_revision', built.includes('request_vulnerability_revision'));
ck('编排器 spawn_agent 不重复', built.filter(n => n === 'spawn_agent').length === 1);
ck('编排器持有 dispatch/relay', built.includes('dispatch_agents') && built.includes('relay_to_agents'));

// ---------- dynamic prompt roster (kills prompt/matrix drift) ----------
const sys = orch.agent.state.systemPrompt;
ck('提示词动态清单含实际工具', sys.includes('- report_vulnerability')
  && sys.includes('- publish_intel') && sys.includes('- dispatch_agents'));
ck('提示词含判据指南', sys.includes('TOOLS_GUIDE 判据') || sys.includes('本会话注册工具'));
const recon = store.create('recon', { workSessionId: 'ws' });
ck('recon 提示词不含 dispatch', !recon.agent.state.systemPrompt.includes('- dispatch_agents'));

// ---------- writer session topology ----------
const writer = store.create('report', { workSessionId: 'ws' });
ck('writer 无父边独立根', store.parentNodeId(writer) === null
  && store.rootIdOf(writer.id) === writer.id);
ck('writer 不在任何树', store.countTree(store.rootIdOf(orch.id), { activeOnly: true }) === 1);

// ---------- quota lifecycle ----------
const c1 = store.create('recon', { workSessionId: 'ws', engagementId: 'eg' });
ck('未交报告计活跃', store.countTree(store.rootIdOf(c1.id)) === 1);
c1.taskReportCount = 1; c1.busy = false;
ck('交报告后不计活跃', store.countTree(store.rootIdOf(c1.id), { activeOnly: true }) === 0);
c1.busy = true;
ck('重激活重新计入', store.countTree(store.rootIdOf(c1.id), { activeOnly: true }) === 1);
const beforeN = c1.taskReportCount;
store.markReportSynthesized(c1, { title: '[系统代拟] t', status: 'no-result' });
ck('markReportSynthesized 计数+1', c1.taskReportCount === beforeN + 1);

// ---------- awaitCompletion ----------
writer.busy = true;
let resolved = false;
const p = store.awaitCompletion(writer).then(() => { resolved = true; });
await new Promise(r => setTimeout(r, 30));
ck('等待挂起中', !resolved);
writer.completionWaiters.forEach(fn => fn());
writer.completionWaiters = [];
await p;
ck('agent_end 语义 resolve', resolved);

// ---------- engagement members ----------
const e1 = store.create('recon', { workSessionId: 'ws', engagementId: 'eng-m1' });
store.create('api', { workSessionId: 'ws', engagementId: 'eng-m1' });
const members = store.engagementMembersOf('eng-m1').sort();
ck('engagement 成员派生', members.join(',') === 'api,recon' || members.join(',') === e1.agentKey + ',api');

finish();
