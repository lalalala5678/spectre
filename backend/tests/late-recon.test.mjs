/** r29b-残留②: 送达时对账段(buildLateRecon)注入式正样本——竞态难实战
 * 摆拍, 纯函数直测三种形态: 构建后落账(勿判失败)/未覆盖(以库为准)/空。 */
import { buildLateRecon } from '../activities.mjs';
import { ck, finish } from './helpers.mjs';

// ①构建后落账: 快照判死、送达时终报已在库 → 必须出现"勿判失败"
const hit = buildLateRecon(['recon'], {
  recon: { status: 'success', title: 'r30 资产测绘终报', seq: 4901 },
});
ck('落账命中含勿判失败', hit.includes('recon: 终报已落账(success)'));
ck('落账命中带 seq 锚点', hit.includes('seq=4901'));
ck('段头免责声明在位', hit.includes('终局以 query_intel 为准'));

// ②未覆盖: 送达时库里仍无 → 明示"以库为准"而非判死
const miss = buildLateRecon(['phish'], {});
ck('未覆盖提示以库为准', miss.includes('phish: 快照时点库内仍无终报'));
ck('未覆盖不出现勿判失败', !miss.includes('勿判失败'));

// ③空 recheck: 不产生段(通知本体干净)
ck('空 recheck 无对账段', buildLateRecon([], { recon: { status: 'success' } }) === '');

// ④多席并列(逐席一行)
const multi = buildLateRecon(['api', 'c2'], {
  api: { status: 'success', title: 't', seq: 1 },
});
ck('多席逐行', multi.includes('- api:') && multi.includes('- c2:'));

finish();
