/**
 * 派发前能力对账机锁: dispatch_agents 回执披露席位硬依赖 vs 共享层
 * 定向探测的缺口(披露不拦截——环境可能由部署脚本另装, 平台只如实)。
 * 探测失败(null)=跳过对账, 绝不当作"全缺"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrchestratorTools, SEAT_HARD_DEPS } from '../src/tools.mjs';
import { nullWal } from './helpers.mjs';

const rec = { id: 'sess-o', agentKey: 'autopwn', workSessionId: 'ws', activeEngagement: null };

function makeCaps(probe) {
  return {
    dispatch: async () => ({ engagementId: 'eng-t1', agents: ['nday'] }),
    signalEngagement: async () => {},
    emitBus: () => ({}),
    authorOf: () => ({ key: 'autopwn', name: '主控', typeLabel: '编排', depth: 0 }),
    spawnCheck: () => ({ ok: true, depth: 1 }),
    dispatchCheck: () => ({ ok: true }),
    spawnChild: async () => ({ id: 'x' }),
    followUp: () => {},
    listBus: () => [],
    ...(probe ? { probeCliTools: probe } : {}),
  };
}

async function dispatchText(caps, agents) {
  const tools = buildOrchestratorTools(rec, caps);
  const d = tools.find(t => t.name === 'dispatch_agents');
  const out = await d.execute('i', { instruction: '对目标做 NDay 排查', agents });
  return out.content[0].text;
}

test('硬依赖缺口如实披露: 缺 nuclei 时回执含缺口与补齐指引', async () => {
  const text = await dispatchText(makeCaps(async names => names.filter(n => n !== 'nuclei')), ['nday']);
  assert.match(text, /能力缺口/, '回执须披露能力缺口段');
  assert.match(text, /nuclei/, '缺口清单须点名缺失工具');
  assert.match(text, /cli-config/, '须给补齐路径(cli-config 席位)');
});

test('依赖齐备: 回执无缺口段(不噪声)', async () => {
  const all = [...new Set(Object.values(SEAT_HARD_DEPS).flat())];
  const text = await dispatchText(makeCaps(async names => names), ['nday', 'weakcred', 'recon', 'exploit']);
  assert.ok(!text.includes('能力缺口'), `齐备时不应有缺口段, 实得: ${text.slice(-200)}`);
});

test('探测失败(null)=跳过对账, 不制造最大假缺口', async () => {
  const text = await dispatchText(makeCaps(async () => null), ['nday', 'weakcred']);
  assert.match(text, /eng-t1/, '派发照常成功');
  assert.ok(!text.includes('能力缺口'), '沙箱失联时不得把全部依赖报缺');
});

test('真实 shell 语义锁: 裸名回显/末位缺失≠失败/纯缺=[](非 null)', async () => {
  const { probeCliTools } = await import('../src/sandbox/container.mjs');
  // 在装与不在装混合: 回显裸名(无路径), 缺失不毒化整串退出码
  const mixed = await probeCliTools(['ls', 'definitely-not-here-xyz']);
  assert.ok(Array.isArray(mixed), '混合探测不得 null(末位缺失≠失败)');
  assert.deepEqual(mixed, ['ls'], '命中回显裸名(非完整路径)');
  // 纯缺失: 空数组(非 null——null 只留给沙箱失联)
  const none = await probeCliTools(['definitely-not-here-xyz']);
  assert.deepEqual(none, [], '纯缺失=空数组');
});

test('探测抛错=跳过对账(容错面)', async () => {
  const text = await dispatchText(makeCaps(async () => { throw new Error('boom'); }), ['nday']);
  assert.match(text, /eng-t1/, '派发不受对账异常影响');
  assert.ok(!text.includes('能力缺口'), '异常静默跳过');
});

test('无 probeCliTools cap(旧注入面): 行为不变', async () => {
  const text = await dispatchText(makeCaps(null), ['nday']);
  assert.match(text, /eng-t1/, '派发照常成功');
  assert.ok(!text.includes('能力缺口'), '无对账面时不得报缺口');
});

test('定向探测收到的是去重后的依赖全集(非席位分次探测)', async () => {
  let seen = null;
  await dispatchText(makeCaps(async names => { seen = names; return names; }),
    ['recon', 'weakcred', 'nday']);
  assert.deepEqual([...seen].sort(), [...new Set([
    ...SEAT_HARD_DEPS.recon, ...SEAT_HARD_DEPS.weakcred, ...SEAT_HARD_DEPS.nday,
  ])].sort(), '一次探测传全量去重依赖');
  assert.ok(!seen.includes('nmap duplicated'), 'nmap 双席位共用只探测一次');
});
