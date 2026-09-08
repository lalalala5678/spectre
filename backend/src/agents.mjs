/**
 * Registry of SPECTRE stage agents.
 *
 * Base phase: metadata only — every agent runs the identical base pi config.
 * Customization (per-agent prompts/tools/skills) plugs in here later.
 */

export const AGENTS = Object.freeze([
  { key: 'autopwn', name: 'Orchestrator / AutoPwn', role: '主控编排',
    typeLabel: '编排agent' },
  { key: 'recon', name: 'Recon Agent', role: '资产测绘 & 指纹',
    typeLabel: '资产测绘agent' },
  { key: 'nday', name: 'NDay Agent', role: 'N-Day & 变体',
    typeLabel: 'Nday agent' },
  { key: 'weakcred', name: 'WeakCred Agent', role: '弱口令检测',
    typeLabel: '弱口令检测agent' },
  { key: 'api', name: 'API Agent', role: 'API 渗透',
    typeLabel: 'API渗透agent' },
  { key: 'exploit', name: 'VulnHunt Agent', role: '漏洞挖掘',
    typeLabel: '漏洞挖掘agent' },
  { key: 'phish', name: 'Phish Agent', role: '钓鱼',
    typeLabel: '钓鱼agent' },
  { key: 'c2', name: 'C2 Agent', role: 'C2 & 内存马',
    typeLabel: 'C2 agent' },
  { key: 'persistence', name: 'Persistence Agent', role: '权限维持',
    typeLabel: '权限维持agent' },
  { key: 'postex', name: 'PostEx Agent', role: '后渗透',
    typeLabel: '后渗透agent' },
  { key: 'report', name: 'Report Agent', role: '报告编写',
    typeLabel: '报告agent' },
].map(Object.freeze));

const TYPE_LABELS = Object.freeze(
  Object.fromEntries(AGENTS.map(a => [a.key, a.typeLabel])));

/** Canonical stage-type label for provenance blocks (报告/FINDING 溯源). */
export function typeLabelOf(key) {
  return TYPE_LABELS[key] ?? key;
}

export const AGENT_KEYS = AGENTS.map(a => a.key);

export function isAgentKey(key) {
  return AGENT_KEYS.includes(key);
}
