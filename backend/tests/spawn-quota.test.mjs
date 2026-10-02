/** F66: spawn 配额边界契约(确定性)——深度 3 硬顶/活跃 8 硬顶/
 * 批量预检/报告后槽位释放。Run: node --test tests/ */
import { makeWorld, ck, finish } from './helpers.mjs';
import { makeSpawnPolicy } from '../src/spawn-policy.mjs';
import { setSpawnSettings } from '../src/settings.mjs';

const { store } = makeWorld();
const policy = makeSpawnPolicy(store);

// 树: root(orchestrator) → A → B → C(深度 0/1/2/3)
const root = store.create('autopwn', { workSessionId: 'ws-quota' });
const a = store.create('recon', { parentSessionId: root.id, workSessionId: 'ws-quota' });
const b = store.create('nday', { parentSessionId: a.id, workSessionId: 'ws-quota' });

setSpawnSettings({ spawnMaxDepth: 3, spawnMaxAgents: 8 });
let v = policy.spawnCheck(b, 'weakcred');
ck('深度 3 内放行(root0→b2, 子3)', v.ok === true && v.depth === 3);

const c = store.create('weakcred', { parentSessionId: b.id, workSessionId: 'ws-quota' });
v = policy.spawnCheck(c, 'api');
ck('深度 4 拒绝并报层级', v.ok === false && v.depth === 4 && String(v.reason).includes('深度上限 3'));

// 活跃上限: 当前树 root+a+b+c = 4 活跃。补 3 个 → 7。再 spawn 第 8 放行, 第 9 拒。
const extra = [];
for (let i = 0; i < 3; i++) {
  extra.push(store.create('api', { parentSessionId: root.id, workSessionId: 'ws-quota' }));
}
v = policy.spawnCheck(root, 'phish');   // active 7 → 8 ≤ 8
ck('活跃 8 内放行', v.ok === true && v.active === 7);
const eighth = store.create('phish', { parentSessionId: root.id, workSessionId: 'ws-quota' });
v = policy.spawnCheck(root, 'c2');      // active 8 → 9 > 8
ck('活跃 9 拒绝并给恢复路径', v.ok === false && v.active === 8 && String(v.reason).includes('不计入名额'));

// 槽位释放: 提交报告(taskReportCount>0)且不 busy → activeOnly 不计。
eighth.taskReportCount = 1;
const freed = policy.spawnCheck(root, 'c2');
ck('报告后槽位释放', freed.ok === true && freed.active === 7, `active=${freed.active}`);

// 批量预检 dispatchCheck: 当前可容纳数量
v = policy.dispatchCheck(root, 1);
ck('批量 1 放行', v.ok === true);
v = policy.dispatchCheck(root, 100);
ck('批量超配拒绝并报缺口', v.ok === false && String(v.reason).includes('名额'));

// 恢复默认
setSpawnSettings({});
finish();

