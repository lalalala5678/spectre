/** r39-O4: status 推断——结论位强成功词优先(描述性"部分"不再压倒
 * 显式结论)。复现样本: 编排者终报 outcome 明写 success 却被标 partial。 */
import { ck, finish } from './helpers.mjs';

// 提取与 tools.mjs 同源推断逻辑做镜像断言(推断器为内联闭包, 行为镜像
// 测试; tools 层改动时此测试须同步)。
function infer(params) {
  let status = params.status ? String(params.status).toLowerCase() : null;
  if (!status) {
    const o = `${params.outcome ?? ''}\n${params.title ?? ''}`.toLowerCase();
    const outcomeHead = (params.outcome ?? '').trim().slice(0, 40).toLowerCase();
    const outcomeTail = (params.outcome ?? '').trim().slice(-40).toLowerCase();
    const strongSuccess = /全部通过|全部完成|全数通过|完全成功|整体成功|总体成功|全程成功|^success|success$/.test(outcomeTail)
      || /\bsuccess\b/.test(String(params.title ?? '').toLowerCase());
    status = (/^(任务|执行|整体)?(失败|failed)|超时|timeout/.test(outcomeHead)
        || /任务失败|执行失败|整体失败|operation failed/.test(o))
      ? 'failed'
      : strongSuccess
        ? 'success'
        : /部分|partial|未完成/.test(o)
          ? 'partial'
          : (params.outcome ?? '').trim()
            ? 'success'
            : 'partial';
  }
  return status;
}

// 复现样本: 正文含"部分覆盖"描述但结论明写 success → 须 success
ck('r39 复现: 描述部分+结论 success', infer({
  outcome: '十个端点中三个启用部分覆盖校验, 其余全通; 目标全部完成, 任务 success',
  title: 'r39 席位终报',
}) === 'success');
// 模糊"部分"无结论 → 仍 partial(保守面保持)
ck('无结论的描述性部分仍 partial', infer({
  outcome: '完成部分覆盖测试, 三个端点启用校验',
  title: '中期快报',
}) === 'partial');
// 失败词优先级不动
ck('失败词仍最高', infer({ outcome: '任务失败: 通道被拒', title: 'x' }) === 'failed');
// 标题 success 也算强结论
ck('标题 success', infer({ outcome: '部分路径 404, 预期内', title: 'api-matrix success' }) === 'success');
// 空兜底不动
ck('空 outcome 兜底 partial', infer({ outcome: '', title: 't' }) === 'partial');

finish();
