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
  { key: 'weakcred', name: 'Brute Agent', role: '目录·登录·API·服务爆破',
    typeLabel: '爆破智能体' },
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
  { key: 'skill-config', name: 'Skill Config Agent', role: '技能配置',
    typeLabel: '技能配置agent' },
  { key: 'mcp-config', name: 'MCP Config Agent', role: 'MCP配置',
    typeLabel: 'MCP配置agent' },
  { key: 'cli-config', name: 'CLI Config Agent', role: 'CLI配置',
    typeLabel: 'CLI配置agent' },
].map(Object.freeze));

const TYPE_LABELS = Object.freeze(
  Object.fromEntries(AGENTS.map(a => [a.key, a.typeLabel])));

/** Canonical stage-type label for provenance blocks (报告/漏洞 溯源). */
export function typeLabelOf(key) {
  return TYPE_LABELS[key] ?? key;
}

export const AGENT_KEYS = AGENTS.map(a => a.key);

/** 配置三键(AGENTS.md 铁律:有且只有)——唯一权威来源。 */
export const CONFIG_AGENT_KEYS = ['skill-config', 'mcp-config', 'cli-config'];

export function isAgentKey(key) {
  return AGENT_KEYS.includes(key);
}
