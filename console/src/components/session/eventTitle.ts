/**
 * CS44-F9: 情报条目标题剥前缀单源——此前三处正则三种变体(情报上报|产出 /
 * 情报 / 不剥), 同一数据列表/详情两视图口径分叉。
 */
const TITLE_PREFIX_RE = /^(情报上报|情报|产出)[:：]?/;

export function stripEventTitle(summary: string, maxChars = 60): string {
  return summary.replace(TITLE_PREFIX_RE, '').slice(0, maxChars);
}
