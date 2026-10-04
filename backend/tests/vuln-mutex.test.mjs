/** r29-#2: writer 落账互斥——vulnMutexCheck 短窗拦截契约(确定性)。
 * 同项目同 severity 且 title+detail token 重叠≥70% 且 120s 窗内 → blocked;
 * 跨项目 / 不同 severity / 修订版 / 低重叠 → 放行(null)。零吞并:
 * 拦截只返回指引, 库内不落任何事件。 */
import { Bus } from '../src/bus.mjs';
import { nullWal, ck, finish } from './helpers.mjs';

const bus = new Bus(nullWal);
const base = {
  channel: 'dm', from: 'report', to: 'user', type: 'vulnerability',
  severity: 'high', title: 'Range29 /api/v1/users IDOR 越权访问',
  detail: '发现过程: api 席矩阵验证 /api/v1/users?id= 任意读, POC: curl -H auth 1..999, 危害: 全量用户数据',
  workSessionId: 'ws-a',
};
const first = bus.emit({ ...base });
ck('首落放行', first.seq > 0);

// 同点位第二 writer → 拦截
const block = bus.vulnMutexCheck({ ...base, title: base.title + ' (复检)' });
ck('高重叠拦截', block?.blocked === true);
ck('dupSeq 指向首落', block.dupSeq === first.seq);
ck('拦截不落账', bus.list().length === 1);

// 跨项目放行
ck('跨项目放行', bus.vulnMutexCheck({ ...base, workSessionId: 'ws-b' }) === null);
// r29b-V3': 不同 severity 高重叠亦拦截——定级分歧逃逸曾致 4864/4866 双正本
ck('不同 severity 高重叠拦截', bus.vulnMutexCheck({ ...base, severity: 'critical' })?.blocked === true);
// 修订版放行
ck('修订版放行', bus.vulnMutexCheck({ ...base, revises: first.seq }) === null);
// 低重叠+不同端点(真不同漏洞)放行
ck('低重叠异端点放行', bus.vulnMutexCheck({
  ...base, title: 'Range29f /backup/.env 敏感配置文件暴露',
  detail: 'recon 席目录枚举命中 /backup/.env, POC: curl --path-as-is, 危害: 数据库凭据泄露',
}) === null);

// r29f-A: 同端点独立撰写(低 token 重叠)也拦——端点指纹条件
// 场景还原 4920/4921: 先落 /pay-key 独立扩写版, 后报同端点再扩写版
const payA = bus.emit({
  channel: 'dm', from: 'report', to: 'user', type: 'vulnerability',
  severity: 'high', workSessionId: 'ws-a',
  title: 'Range29f /pay-key 无鉴权硬编码支付密钥泄露(CWE-798)',
  detail: 'writer-A 独立取证: 配置文件定位硬编码, 影响面与修复建议, 附抓包复现脚本一份完整行文。',
});
const indep = {
  channel: 'dm', from: 'report', to: 'user', type: 'vulnerability',
  severity: 'high', workSessionId: 'ws-a',
  title: 'Range29f /pay-key 无鉴权硬编码支付网关密钥泄露',
  detail: 'writer-B 独立扩写: 从路由代码与部署清单两处交叉取证, 确认泄露点与调用链, 全新行文附网络抓包与复现脚本, 加固建议另附三段。',
};
ck('同端点独立撰写拦截', bus.vulnMutexCheck(indep)?.blocked === true);
ck('指纹命中带 by 标记', bus.vulnMutexCheck(indep)?.by === 'fingerprint');
ck('dupSeq 指向同端点先账', bus.vulnMutexCheck(indep).dupSeq === payA.seq);

// 窗外放行: 手工把首落 ts 拨回 3 分钟前
const old = bus.events.find(e => e.seq === first.seq);
old.ts = new Date(Date.now() - 601_000).toISOString();
ck('10min 窗外放行', bus.vulnMutexCheck({ ...base }) === null);
// 窗内边界: 9min(540s)仍在窗内——writer 耗时量级竞态必须覆盖
old.ts = new Date(Date.now() - 540_000).toISOString();
ck('9min 窗内仍拦', bus.vulnMutexCheck({ ...base })?.blocked === true);

// 窗外+内容演进 → 真入库(既有 detail 全等幂等仍守: 同文重发返回 dup)
const second = bus.emit({ ...base, title: base.title + ' (窗口外)',
  detail: base.detail + '; 复检补证: 新增 999 号租户命中' });
ck('窗口外演进版正常入库', second.seq > first.seq);
const dupAgain = bus.emit({ ...base, title: base.title + ' (窗口外)',
  detail: base.detail + '; 复检补证: 新增 999 号租户命中' });
ck('同文重发幂等返回原 seq', dupAgain.seq === second.seq);

finish();
