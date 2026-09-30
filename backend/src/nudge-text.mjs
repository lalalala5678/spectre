/**
 * Report nudge text — single source of truth (CS1-A4/D1).
 *
 * 纯字符串常量模块: 无任何 import/副作用, Temporal workflow 可安全引
 * 用(determinism 约束)。此前 sessions.mjs 与 workflows.mjs 各持一份
 * "双胞胎常量", 内容漂移到 workflows 侧把 status 说成必填——与工具
 * schema(tools.mjs status: Type.Optional + 推断)和 AGENTS.md"必填改
 * Optional+推断"矛盾, 催办给 LLM 的字段契约是错的。收敛到本模块。
 */
export const REPORT_NUDGE_TEXT = '【系统要求】本段运行尚未提交任务报告。请立即调用 ' +
  'submit_task_report(字段:title/task/actions/outcome;status 建议填写,' +
  '遗漏时系统会按 outcome 推断),说明做了什么、结果或失败原因与全部必要信息——' +
  '即使没有任何发现也必须提交。这是结束任务的必要条件;提交后本任务即告完成。';
