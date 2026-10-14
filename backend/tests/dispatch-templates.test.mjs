/**
 * 战役剧本机锁: dispatch_agents 模板参数——成功战役的派发参数存为可
 * 复用模板("泛微专项/统一认证专项"一键开战), 模板加载/发现/保存三面。
 * 红→绿协议: 模板实现前本文件红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrchestratorTools } from '../src/tools.mjs';
import { nullWal } from './helpers.mjs';

const rec = { id: 'sess-o', agentKey: 'autopwn', workSessionId: 'ws', activeEngagement: null };

function makeCaps(store = new Map(), log = []) {
  return {
    dispatch: async input => { log.push(input); return { engagementId: 'eng-' + input.agents.join('-'), agents: input.agents }; },
    signalEngagement: async () => {},
    emitBus: () => ({}),
    authorOf: () => ({ key: 'autopwn', name: '主控', typeLabel: '编排', depth: 0 }),
    saveTemplate: async (name, payload) => { store.set(name, payload); return { ok: true }; },
    dispatchCheck: () => ({ ok: true }),
    spawnChild: async () => ({ id: 'x' }),
    followUp: () => {},
    listBus: () => [],
    probeCliTools: async names => names,
    getTemplate: async name => store.get(name) ?? null,
    listTemplates: async () => [...store.entries()].map(([name, p]) => ({ name, agents: p.agents })),
    _log: log,
  };
}

async function dispatch(caps, params) {
  const tools = buildOrchestratorTools(rec, caps);
  const d = tools.find(t => t.name === 'dispatch_agents');
  const out = await d.execute('i', params);
  return out.content[0].text;
}

test('保存→复用: saveAsTemplate 后 template= 名一键展开 agents/指令', async () => {
  const caps = makeCaps();
  const saved = await dispatch(caps, {
    instruction: '泛微专项: 找 e-cology 面并验证 VerifyQuickLogin 等族',
    agents: ['recon', 'nday', 'exploit'],
    sharedContext: '泛微指纹优先 VerifyQuickLogin',
    saveAsTemplate: 'weaver-suite',
  });
  assert.match(saved, /模板未存.*未知|已存为模板.*weaver-suite/, '保存回执须确认模板名');
  // 复用: 只传 template, 不传 agents/instruction
  const used = await dispatch(caps, { template: 'weaver-suite' });
  assert.match(used, /eng-recon-nday-exploit/, '模板 agents 须展开(三席派发)');
  const dispatched = caps._log.at(-1);
  assert.ok(dispatched.instruction.includes('泛微专项'),
    `dispatch 输入须含模板指令, 实得: ${dispatched.instruction.slice(0, 60)}`);
  assert.ok(dispatched.instruction.includes('泛微指纹优先'), '模板 sharedContext 须随指令注入');
});

test('模板不存在: 回执列出可用模板清单(发现面)', async () => {
  const caps = makeCaps();
  await dispatch(caps, { instruction: 'x', agents: ['recon'], saveAsTemplate: 't1' });
  const r = await dispatch(caps, { template: 'no-such' });
  assert.match(r, /不存在/, '须声明模板不存在');
  assert.match(r, /t1/, '须列出可用模板');
});

test('显式参数覆盖模板字段(局部定制)', async () => {
  const caps = makeCaps();
  await dispatch(caps, { instruction: '基线指令', agents: ['recon'], saveAsTemplate: 'base' });
  const r = await dispatch(caps, { template: 'base', agents: ['recon', 'nday'] });
  assert.match(r, /eng-recon-nday/, '显式 agents 覆盖模板 agents');
  assert.ok(caps._log.at(-1).instruction.includes('基线指令'), '未覆盖字段用模板值(dispatch 输入)');
});

test('无模板 caps(旧注入面): 不传 template 时行为不变', async () => {
  const caps = makeCaps();
  delete caps.saveTemplate; delete caps.getTemplate; delete caps.listTemplates;
  const r = await dispatch(caps, { instruction: '直接派发', agents: ['nday'] });
  assert.match(r, /eng-nday/, '无模板面时常规派发不受影响');
});

test('schema 层可达: {template:X} 通过必填校验(instruction/agents Optional)', async () => {
  // P1(对抗审查): instruction/agents 曾为必填——生产执行链的
  // validateToolArguments 会直接 throw, 模板展开永不生效(测试直调
  // execute 绕过了验证层)。本用例锁 schema 形状本身。
  const tools = buildOrchestratorTools(rec, makeCaps());
  const d = tools.find(t => t.name === 'dispatch_agents');
  // TypeBox Optional 的规范表征: 不进 required 数组(而非 optional 标志)
  const req = d.parameters.required ?? [];
  assert.ok(!req.includes('instruction'), `instruction 不得在 required(实得 ${JSON.stringify(req)})`);
  assert.ok(!req.includes('agents'), `agents 不得在 required(实得 ${JSON.stringify(req)})`);
});

test('保存原始三元组: 存档指令不含平台标注/共享区(复用不双重标注)', async () => {
  const caps = makeCaps();
  await dispatch(caps, { instruction: '原始指令', agents: ['recon'],
    sharedContext: 'SC 内容', saveAsTemplate: 'clean-tpl' });
  const tpl = await caps.getTemplate('clean-tpl');
  assert.ok(tpl, '模板已存');
  assert.ok(!tpl.instruction.includes('平台自有资产'), '存档指令不得含平台标注');
  assert.ok(!tpl.instruction.includes('共享参数区'), '存档指令不得含共享区注入');
  assert.ok(!tpl.instruction.includes('SC 内容'), 'sharedContext 不重复入指令');
  assert.equal(tpl.sharedContext, 'SC 内容', 'sharedContext 独立字段');
});

test('分波路径(>5 席)saveAsTemplate 同样生效', async () => {
  const caps = makeCaps();
  const r = await dispatch(caps, {
    instruction: '六席大战役', agents: ['recon', 'nday', 'weakcred', 'api', 'exploit', 'postex'],
    saveAsTemplate: 'wave-tpl',
  });
  assert.match(r, /已存为模板.*wave-tpl/, `分波回执须含保存确认, 实得尾: ${r.slice(-120)}`);
  const tpl = await caps.getTemplate('wave-tpl');
  assert.equal(tpl?.agents?.length, 6, '六席全量入模板');
});
