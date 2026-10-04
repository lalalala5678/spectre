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

// loop21-①: 正文提及异端点不再误拦(title-only 指纹)——弱口令洞
// 正文连带 /pay-key 攻击链语境曾被 BOLA 正本端点字面量误拦三次
const weak = {
  channel: 'dm', from: 'report', to: 'user', type: 'vulnerability',
  severity: 'high', workSessionId: 'ws-a',
  title: 'Range30 登录接口弱口令 carol/Password1 命中',
  detail: 'weakcred 席爆破命中; 利用路径: 持该口令可打 /pay-key 支付接口(与既有 BOLA 正本同链), '
    + 'POC: curl -u carol:Password1 登录后直达 /pay-key, 危害: 资金面完全失守。',
};
ck('正文提及异端点放行(loop21 误拦修复)', bus.vulnMutexCheck(weak) === null);

// loop22: TCP 服务端口形态——措辞分歧同端口(authd 18402 无 /path,
// 5173/5177 双账穿透)由 port: 指纹拦截; CVE 年份不产生假指纹
const authA = bus.emit({
  channel: 'dm', from: 'report', to: 'user', type: 'vulnerability',
  severity: 'medium', workSessionId: 'ws-a',
  title: 'r32 authd(18402) 全账户弱口令(CWE-521)',
  detail: 'writer-A 独立取证: 127.0.0.1:18402 TCP 行协议, 无失败锁定与明文口令日志, 附账号枚举与爆破脚本。',
});
ck('同端口措辞分歧拦截(5173/5177 场景)', bus.vulnMutexCheck({
  channel: 'dm', from: 'report', to: 'user', type: 'vulnerability',
  severity: 'high', workSessionId: 'ws-a',
  title: 'r32 authd 18402 三账号弱口令+无锁定(CWE-521/307)',
  detail: 'writer-B 独立扩写: 靶场 TCP 认证服务三账号弱口令叠加无锁定/无限速, 全新行文。',
})?.by === 'fingerprint');
ck('CVE 年份不假撞', bus.vulnMutexCheck({
  channel: 'dm', from: 'report', to: 'user', type: 'vulnerability',
  severity: 'high', workSessionId: 'ws-a',
  title: 'r32 反序列化 RCE(CVE-2024-1234) 利用链披露',
  detail: '完全不同的漏洞: Java 反序列化 gadget 链, 与 authd 弱口令无任何行文交集, POC 为恶意序列化 payload。',
}) === null);

// loop21-复测 C/D 案(验收方三角重放)入回归组
// C: 标题与库内零重叠 + 正文逐字引用先账标题/端点/密钥 → 必须放行
ck('C案 正文逐字引用也放行', bus.vulnMutexCheck({
  channel: 'dm', from: 'report', to: 'user', type: 'vulnerability',
  severity: 'high', workSessionId: 'ws-a',
  title: '支付网关凭据治理失效放大链',
  detail: '复核确认《Range29f /cfg-leak 无鉴权硬编码支付配置泄露》中 /cfg-leak 的 api_key=sk_live_9f3 有效, 全新行文。',
}) === null);
// D: 标题复用泛化词 + 端点全新 + 正文干净 → 必须放行
ck('D案 泛化标题词放行', bus.vulnMutexCheck({
  channel: 'dm', from: 'report', to: 'user', type: 'vulnerability',
  severity: 'high', workSessionId: 'ws-a',
  title: 'Range31b 硬编码密钥泄露(泛化复用词样例)',
  detail: '另一全新端点 /vault-backup 的独立取证正文, 与既有条目无行文交集。',
}) === null);

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
