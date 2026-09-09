import type {
  AgentId, AgentMeta, Skill, McpServer, TaskNode, Finding, AuditRecord, AutoPwnConstraints,
  Span, AgentMessage,
} from '../types';

// ---------------- Agents ----------------

export const AGENTS: AgentMeta[] = [
  {
    id: 'orchestrator', name: 'Orchestrator', codename: 'AutoPwn 主控',
    desc: '接收目标后自主拆解任务图，调度各阶段 Agent，处理依赖、冲突与审批升级。',
    status: 'idle', model: 'deepseek-v4-pro', version: 'v2.4.1',
    skills: ['task-graph', 'scope-guard', 'debate-verify'], mcpServers: ['task-db', 'evidence-store'],
  },
  {
    id: 'recon', name: 'Recon Agent', codename: '资产测绘 & 指纹',
    desc: '子域枚举、端口测绘、Web 资产发现、指纹/CMS/中间件识别、攻击面建模。',
    status: 'running', model: 'kimi-k3', version: 'v1.9.0',
    skills: ['subdomain-enum', 'port-masscan', 'wappalyzer-plus', 'web-crawl'], mcpServers: ['amap-fofa', 'dns-resolver'],
  },
  {
    id: 'nday', name: 'NDay Agent', codename: 'N-Day & 变体',
    desc: 'N-Day 漏洞匹配、变种发现、PoC 沙箱验证与误报反证。',
    status: 'idle', model: 'kimi-k3', version: 'v1.7.3',
    skills: ['nuclei-nday', 'variant-hunt', 'poc-verify'], mcpServers: ['cve-db', 'sandbox-runner'],
  },
  {
    id: 'weakcred', name: 'WeakCred Agent', codename: '弱口令检测',
    desc: '服务/后台弱口令检测、默认凭据库匹配、已获凭据跨服务复用测试。',
    status: 'idle', model: 'kimi-k3', version: 'v1.1.2',
    skills: ['weakcred-check', 'default-cred-db', 'cred-reuse'], mcpServers: ['wordlist-store'],
  },
  {
    id: 'api', name: 'API Agent', codename: 'API 渗透',
    desc: 'API 资产发现、Schema 还原、越权/注入/业务逻辑漏洞测试。',
    status: 'idle', model: 'kimi-k3', version: 'v1.0.4',
    skills: ['api-discovery', 'schema-loot', 'bola-check'], mcpServers: ['http-replayer'],
  },
  {
    id: 'exploit', name: 'VulnHunt Agent', codename: '漏洞挖掘',
    desc: '通用 Web 漏洞利用：SQL 注入、XSS、文件上传、路径穿越、配置缺陷（管理页/调试端点/.git 泄露）等，除 API/弱口令/N-Day 外的漏洞路径。',
    status: 'idle', model: 'deepseek-v4-pro', version: 'v2.1.0',
    skills: ['sqli-suite', 'xss-probe', 'misconfig-audit', 'upload-bypass'], mcpServers: ['sandbox-runner', 'http-replayer'],
  },
  {
    id: 'phish', name: 'Phish Agent', codename: '钓鱼',
    desc: '钓鱼页面克隆、钓鱼邮件生成、凭据收割通道与回传。',
    status: 'idle', model: 'kimi-k3', version: 'v0.9.1',
    skills: ['phish-clone', 'lure-craft', 'cred-harvest'], mcpServers: ['mail-relay'],
  },
  {
    id: 'c2', name: 'C2 Agent', codename: 'C2 免杀 & 内存马',
    desc: '载荷免杀处理、内存马注入（Filter/Listener/Agent），通道建立。',
    status: 'idle', model: 'deepseek-v4-pro', version: 'v1.4.2',
    skills: ['shellcode-obf', 'memshell-inject', 'c2-profile'], mcpServers: ['c2-infra'],
  },
  {
    id: 'persistence', name: 'Persistence Agent', codename: '权限维持',
    desc: '隧道搭建（frp/iodine/sshuttle）、计划任务、凭据持久化。',
    status: 'idle', model: 'kimi-k3', version: 'v1.2.8',
    skills: ['tunnel-build', 'privesc-enum'], mcpServers: ['relay-pool'],
  },
  {
    id: 'postex', name: 'PostEx Agent', codename: '后渗透',
    desc: '内网横向、凭据收集、敏感数据定位、域渗透路径推演。',
    status: 'idle', model: 'deepseek-v4-pro', version: 'v1.6.5',
    skills: ['lateral-move', 'cred-dump-sim', 'ad-path'], mcpServers: ['bloodhound-api'],
  },
  {
    id: 'report', name: 'Report Agent', codename: '报告编写',
    desc: '证据链汇总、CVSS 定级、复现步骤编排，输出可交付渗透报告。',
    status: 'idle', model: 'kimi-k3', version: 'v1.3.1',
    skills: ['report-render', 'cvss-score'], mcpServers: ['evidence-store'],
  },
  {
    id: 'skill-config', name: 'Skill Config Agent', codename: '技能配置',
    desc: '为指定智能体配置 skill:链接下载、上传包、从零撰写。',
    status: 'idle', model: 'glm-5.3', version: 'v1.0.0',
    skills: [], mcpServers: [],
  },
  {
    id: 'mcp-config', name: 'MCP Config Agent', codename: 'MCP配置',
    desc: '为指定智能体配置 MCP server:注册、连通测试、挂载。',
    status: 'idle', model: 'glm-5.3', version: 'v1.0.0',
    skills: [], mcpServers: [],
  },
  {
    id: 'cli-config', name: 'CLI Config Agent', codename: 'CLI配置',
    desc: '向共享沙箱环境安装 CLI 工具(装一次全体智能体可用)。',
    status: 'idle', model: 'glm-5.3', version: 'v1.0.0',
    skills: [], mcpServers: [],
  },

];

// ---------------- AutoPwn 默认约束 ----------------

export const DEFAULT_CONSTRAINTS: AutoPwnConstraints = {
  orgName: 'Example Corp',
  scopeLocked: false,
  allowExploit: true,
  allowC2: false,
  allowPersistence: false,
  rateLimit: 50,
  timeBudgetMin: 120,
  requireApproval: 'exploit+',
};

/** Recon Agent 产出的建议范围（待用户采纳） */
export const SUGGESTED_SCOPE = {
  domains: ['example-corp.com', '*.example-corp.com', 'example-corp.cn'],
  cidrs: ['203.0.113.0/28'],
  asn: 'AS64500',
  outOfScope: ['pay.example-corp.com（第三方支付，建议排除）'],
};

// ---------------- AutoPwn 任务图 ----------------

export const AUTOPWN_GRAPH: TaskNode[] = [
  { id: 't1', stage: 'recon', origin: 'planned', title: '组织名解析 → 攻击面测绘：Example Corp', status: 'success', dependsOn: [], summary: '由公司名解析出 3 个主域 / 1 个 ASN；14 个子域、6 个存活 Web、2 个管理后台；识别 Confluence 8.5.3 / Nginx 1.24', startedAt: '02:01:04', finishedAt: '02:06:31' },
  { id: 't2', stage: 'nday', origin: 'planned', title: 'N-Day 匹配 & 变体验证', status: 'success', dependsOn: ['t1'], summary: '命中 CVE-2023-22515、CVE-2024-21887；补丁差异分析发现 1 个疑似变体', startedAt: '02:06:31', finishedAt: '02:11:12' },
  { id: 't3', stage: 'weakcred', origin: 'generated', reason: '由 t1 结果插入：发现 Grafana / 邮箱 OWA 登录口', title: '弱口令检测：Grafana + OWA + SSH', status: 'success', dependsOn: ['t1'], summary: 'Grafana admin/admin 命中；OWA 与 SSH 未命中（已按速率限制中止）', startedAt: '02:07:02', finishedAt: '02:10:40' },
  { id: 't4', stage: 'exploit', origin: 'planned', title: '利用链验证：Confluence 未授权 → RCE', status: 'running', dependsOn: ['t2'], summary: '沙箱 PoC 通过，正在等待真实目标利用审批', startedAt: '02:11:12' },
  { id: 't5', stage: 'c2', origin: 'planned', title: 'C2 通道建立 + Tomcat 内存马', status: 'blocked', dependsOn: ['t4'], summary: '约束集未授权 allowC2=false，等待用户显式开启' },
  { id: 't6', stage: 'persistence', origin: 'hypothetical', title: '权限维持（若 C2 建立）', status: 'pending', dependsOn: ['t5'], summary: '假设推演：frp 隧道 + 服务自启；仅在 t5 成功后实例化' },
  { id: 't7', stage: 'postex', origin: 'generated', reason: '由 t2 结果插入：wiki 服务器位于 DMZ，存在内网路由', title: '后渗透：DMZ → 内网 192.168.0/24 横向', status: 'pending', dependsOn: ['t5'], summary: 'BloodHound 预查询：该网段存在 3 台域控候选' },
  { id: 't8', stage: 'report', origin: 'planned', title: '报告生成：证据链 → DOCX/PDF', status: 'pending', dependsOn: ['t7'] },
];

// ---------------- Skills ----------------

export const SKILLS: Skill[] = [
  { id: 'subdomain-enum', name: 'subdomain-enum', source: 'builtin', version: '1.4.0', desc: '被动子域枚举聚合（subfinder/amass/crtsh）', entry: 'skills/subdomain-enum/SKILL.md', risk: 'safe', enabled: true, boundAgents: ['recon'] },
  { id: 'wappalyzer-plus', name: 'wappalyzer-plus', source: 'builtin', version: '2.1.0', desc: 'Web 指纹 / CMS / 中间件识别（规则库周更）', entry: 'skills/wappalyzer-plus/SKILL.md', risk: 'safe', enabled: true, boundAgents: ['recon'] },
  { id: 'nuclei-nday', name: 'nuclei-nday', source: 'registry', version: '3.2.1', desc: 'Nuclei 模板 N-Day 匹配，含自定义模板热加载', entry: 'skills/nuclei-nday/SKILL.md', risk: 'intrusive', enabled: true, boundAgents: ['nday'] },
  { id: 'variant-hunt', name: 'variant-hunt', source: 'registry', version: '0.5.2', desc: 'N-Day 变体发现：补丁差异分析与未公开变体检索', entry: 'skills/variant-hunt/SKILL.md', risk: 'intrusive', enabled: true, boundAgents: ['nday'] },
  { id: 'poc-verify', name: 'poc-verify', source: 'builtin', version: '0.9.2', desc: 'PoC 沙箱复验与误报反证', entry: 'skills/poc-verify/SKILL.md', risk: 'safe', enabled: true, boundAgents: ['nday', 'exploit'] },
  { id: 'weakcred-check', name: 'weakcred-check', source: 'builtin', version: '1.3.0', desc: '服务弱口令检测（SSH/RDP/DB/Web 登录口，限速防锁定）', entry: 'skills/weakcred-check/SKILL.md', risk: 'credential', enabled: true, boundAgents: ['weakcred'] },
  { id: 'api-discovery', name: 'api-discovery', source: 'builtin', version: '1.0.2', desc: 'API 端点发现：JS 逆向/swagger/actuator/备份文件', entry: 'skills/api-discovery/SKILL.md', risk: 'intrusive', enabled: true, boundAgents: ['api'] },
  { id: 'schema-loot', name: 'schema-loot', source: 'registry', version: '0.8.0', desc: '从流量/文档还原 API Schema，生成测试用例', entry: 'skills/schema-loot/SKILL.md', risk: 'safe', enabled: true, boundAgents: ['api'] },
  { id: 'bola-check', name: 'bola-check', source: 'registry', version: '0.4.1', desc: '越权（BOLA/IDOR）与业务逻辑漏洞测试', entry: 'skills/bola-check/SKILL.md', risk: 'intrusive', enabled: true, boundAgents: ['api'] },
  { id: 'default-cred-db', name: 'default-cred-db', source: 'registry', version: '2.4.1', desc: '设备/中间件默认凭据库匹配（4000+ 条目，周更）', entry: 'skills/default-cred-db/SKILL.md', risk: 'safe', enabled: true, boundAgents: ['weakcred'] },
  { id: 'cred-reuse', name: 'cred-reuse', source: 'local', version: '0.6.0', desc: '已获凭据跨服务复用测试与喷射（严格限速 + 锁定保护）', entry: '/opt/skills/cred-reuse/SKILL.md', risk: 'credential', enabled: false, boundAgents: ['weakcred'] },
  { id: 'sqli-suite', name: 'sqli-suite', source: 'local', version: '2.0.0-rc', desc: 'SQL 注入利用链：报错/盲注/OOB 带外', entry: '/opt/skills/sqli-suite/SKILL.md', risk: 'exploit', enabled: true, boundAgents: ['exploit'] },
  { id: 'xss-probe', name: 'xss-probe', source: 'builtin', version: '1.2.0', desc: 'XSS 探测：反射/存储/DOM，含 CSP 绕过变体', entry: 'skills/xss-probe/SKILL.md', risk: 'intrusive', enabled: true, boundAgents: ['exploit'] },
  { id: 'misconfig-audit', name: 'misconfig-audit', source: 'registry', version: '1.5.0', desc: '配置缺陷审计：Tomcat 管理页、debug 端点、.git/备份泄露、目录遍历', entry: 'skills/misconfig-audit/SKILL.md', risk: 'intrusive', enabled: true, boundAgents: ['exploit'] },
  { id: 'upload-bypass', name: 'upload-bypass', source: 'local', version: '0.9.0', desc: '文件上传绕过：MIME/扩展名/内容检测/条件竞争', entry: '/opt/skills/upload-bypass/SKILL.md', risk: 'exploit', enabled: true, boundAgents: ['exploit'] },
  { id: 'phish-clone', name: 'phish-clone', source: 'registry', version: '0.7.0', desc: '目标登录页克隆与同源资源镜像', entry: 'skills/phish-clone/SKILL.md', risk: 'intrusive', enabled: false, boundAgents: ['phish'] },
  { id: 'lure-craft', name: 'lure-craft', source: 'local', version: '0.5.2', desc: '钓鱼邮件/话术生成（按目标组织情境定制）', entry: '/opt/skills/lure-craft/SKILL.md', risk: 'intrusive', enabled: false, boundAgents: ['phish'] },
  { id: 'cred-harvest', name: 'cred-harvest', source: 'registry', version: '0.6.0', desc: '凭据收割通道：表单回传、session 捕获、告警通知', entry: 'skills/cred-harvest/SKILL.md', risk: 'credential', enabled: false, boundAgents: ['phish'] },
  { id: 'shellcode-obf', name: 'shellcode-obf', source: 'local', version: '1.1.4', desc: '载荷混淆与免杀处理（异构加密/间接系统调用）', entry: '/opt/skills/shellcode-obf/SKILL.md', risk: 'exploit', enabled: false, boundAgents: ['c2'] },
  { id: 'memshell-inject', name: 'memshell-inject', source: 'registry', version: '0.8.0', desc: '内存马注入：Tomcat Filter/Listener、Java Agent', entry: 'skills/memshell-inject/SKILL.md', risk: 'exploit', enabled: false, boundAgents: ['c2'] },
  { id: 'tunnel-build', name: 'tunnel-build', source: 'builtin', version: '1.0.6', desc: '隧道编排：frp / iodine / sshuttle / chisel', entry: 'skills/tunnel-build/SKILL.md', risk: 'intrusive', enabled: true, boundAgents: ['persistence'] },
  { id: 'report-render', name: 'report-render', source: 'builtin', version: '1.2.0', desc: '证据链 → DOCX/PDF 报告渲染（CVSS 自动定级）', entry: 'skills/report-render/SKILL.md', risk: 'safe', enabled: true, boundAgents: ['report'] },
  { id: 'ad-path', name: 'ad-path', source: 'registry', version: '0.7.3', desc: 'BloodHound 攻击路径推演与最短链计算', entry: 'skills/ad-path/SKILL.md', risk: 'credential', enabled: true, boundAgents: ['postex'] },
];

// ---------------- MCP Servers ----------------

export const MCP_SERVERS: McpServer[] = [
  {
    id: 'amap-fofa', name: 'fofa-search', transport: 'http',
    endpoint: 'https://mcp.internal/fofa', desc: 'FOFA 网络空间测绘查询封装',
    status: 'connected', envKeys: ['FOFA_KEY'],
    tools: [
      { name: 'fofa_query', desc: '按语法查询资产' },
      { name: 'fofa_stats', desc: '聚合统计' },
    ],
    boundAgents: ['recon'],
  },
  {
    id: 'cve-db', name: 'cve-intel', transport: 'sse',
    endpoint: 'http://127.0.0.1:8788/sse', desc: 'CVE / 漏洞情报库（本地镜像，每日同步）',
    status: 'connected', envKeys: [],
    tools: [
      { name: 'cve_lookup', desc: '按 CVE 编号查询详情与 PoC 链接' },
      { name: 'cve_by_product', desc: '按产品+版本匹配 N-Day' },
    ],
    boundAgents: ['nday', 'exploit'],
  },
  {
    id: 'sandbox-runner', name: 'sandbox-runner', transport: 'stdio',
    endpoint: 'sandboxd --mcp --profile=ephemeral', desc: '一次性隔离沙箱，执行 PoC / 利用验证',
    status: 'connected', envKeys: ['SANDBOX_POOL'],
    tools: [
      { name: 'run_poc', desc: '在临时容器中执行 PoC 并回收输出' },
      { name: 'snapshot_destroy', desc: '销毁沙箱实例' },
    ],
    boundAgents: ['exploit', 'nday'],
  },
  {
    id: 'c2-infra', name: 'c2-infra', transport: 'stdio',
    endpoint: 'c2d --mcp --profile=redteam', desc: 'C2 基础设施：监听器、profile、接入点管理',
    status: 'disconnected', envKeys: ['C2_TOKEN'],
    tools: [
      { name: 'listener_create', desc: '创建 HTTPS/DNS 监听器' },
      { name: 'beacon_list', desc: '列出在线 beacon' },
    ],
    boundAgents: ['c2'],
  },
  {
    id: 'wordlist-store', name: 'wordlist-store', transport: 'http',
    endpoint: 'https://mcp.internal/wordlists', desc: '字典与凭据库（分场景裁剪，只读下发）',
    status: 'connected', envKeys: [],
    tools: [
      { name: 'wordlist_get', desc: '按场景获取裁剪后字典' },
      { name: 'default_creds', desc: '按产品查询默认凭据' },
    ],
    boundAgents: ['weakcred'],
  },
  {
    id: 'http-replayer', name: 'http-replayer', transport: 'http',
    endpoint: 'https://mcp.internal/replay', desc: 'HTTP 流量录制/重放/变异（Burp 风格）',
    status: 'connected', envKeys: [],
    tools: [
      { name: 'replay', desc: '重放请求并支持参数变异' },
      { name: 'diff', desc: '对比两次响应差异' },
    ],
    boundAgents: ['api'],
  },
  {
    id: 'mail-relay', name: 'mail-relay', transport: 'stdio',
    endpoint: 'mailrelayd --mcp --profile=redteam', desc: '钓鱼邮件发送中继与投递状态回执',
    status: 'disconnected', envKeys: ['RELAY_TOKEN'],
    tools: [
      { name: 'send_lure', desc: '发送钓鱼邮件（需审批）' },
      { name: 'delivery_status', desc: '投递/打开状态查询' },
    ],
    boundAgents: ['phish'],
  },
  {
    id: 'evidence-store', name: 'evidence-store', transport: 'http',
    endpoint: 'https://mcp.internal/evidence', desc: '证据链存储：截图、pcap、命令输出，SHA-256 固化',
    status: 'connected', envKeys: [],
    tools: [
      { name: 'evidence_put', desc: '写入证据并返回哈希' },
      { name: 'evidence_chain', desc: '导出完整证据链' },
    ],
    boundAgents: ['orchestrator', 'report'],
  },
  {
    id: 'bloodhound-api', name: 'bloodhound-api', transport: 'http',
    endpoint: 'https://mcp.internal/bh', desc: 'BloodHound CE 图查询接口',
    status: 'error', envKeys: ['BH_TOKEN_ID', 'BH_TOKEN_KEY'],
    tools: [
      { name: 'shortest_path', desc: '最短攻击路径' },
      { name: 'owned_mark', desc: '标记已控节点' },
    ],
    boundAgents: ['postex'],
  },
];

// ---------------- 发现 ----------------

export const FINDINGS: Finding[] = [
  { id: 'f1', severity: 'critical', title: 'CVE-2023-22515 未授权管理员创建', target: 'wiki.example-corp.com', foundBy: 'nday', status: 'verified', cve: 'CVE-2023-22515', evidence: 'ev://a91f…c2' },
  { id: 'f2', severity: 'high', title: 'CVE-2024-21887 命令注入', target: 'vpn.example-corp.com', foundBy: 'nday', status: 'verified', cve: 'CVE-2024-21887', evidence: 'ev://77b0…1d' },
  { id: 'f3', severity: 'medium', title: 'Grafana 默认口令 (admin/admin)', target: 'grafana.example-corp.com', foundBy: 'weakcred', status: 'new', evidence: 'ev://03c4…9a' },
  { id: 'f4', severity: 'low', title: 'TLS 证书 7 天内过期', target: 'mail.example-corp.com', foundBy: 'recon', status: 'new', evidence: 'ev://5e2d…f0' },
  { id: 'f5', severity: 'info', title: '暴露 .git 目录（只读）', target: 'dev.example-corp.com', foundBy: 'recon', status: 'new', evidence: 'ev://88aa…33' },
];

// ---------------- 审计 ----------------

export const AUDIT_LOG: AuditRecord[] = [
  { id: 'a1', ts: '02:01:06', actor: 'user', action: 'session.create', detail: '创建 AutoPwn 会话，导入约束集（4 条 scope 规则）', hash: 'sha256:9f2a…' },
  { id: 'a2', ts: '02:03:12', actor: 'recon', action: 'tool.exec', detail: 'subfinder -d example-corp.com（被动枚举，safe）', approved: true, hash: 'sha256:11bc…' },
  { id: 'a3', ts: '02:07:55', actor: 'nday', action: 'scan.launch', detail: 'nuclei -t cves/ -rl 50（受速率约束）', approved: true, hash: 'sha256:cd04…' },
  { id: 'a4', ts: '02:11:12', actor: 'exploit', action: 'approval.request', detail: '请求对 wiki.example-corp.com 执行真实利用', hash: 'sha256:e7f1…' },
  { id: 'a5', ts: '02:11:30', actor: 'orchestrator', action: 'task.block', detail: 't4 (C2) 被约束集 allowC2=false 阻塞', hash: 'sha256:3d88…' },
];

// ---------------- 子 Agent 调用状态（AutoPwn 右侧面板） ----------------

export interface SubAgentState {
  agentId: AgentId;
  state: 'running' | 'called' | 'idle';
  calls: number;
  lastAction?: string;
  lastTs?: string;
}

/** 子 Agent 的单次调用实例（多级菜单的叶子节点） */
export interface SubAgentCall {
  spanId: string;
  title: string;
  ts: string;
  status: 'running' | 'done' | 'failed';
}

export const SUBAGENT_STATES: SubAgentState[] = [
  { agentId: 'recon', state: 'called', calls: 3, lastAction: 'orgresolve + 端口测绘完成', lastTs: '02:06:31' },
  { agentId: 'nday', state: 'called', calls: 2, lastAction: 'nuclei 扫描完成，2 confirmed', lastTs: '02:09:44' },
  { agentId: 'weakcred', state: 'called', calls: 1, lastAction: 'Grafana admin/admin 命中', lastTs: '02:10:40' },
  { agentId: 'api', state: 'idle', calls: 0 },
  { agentId: 'exploit', state: 'running', calls: 1, lastAction: 'exploit-chain cve-2023-22515 执行中', lastTs: '02:13:02' },
  { agentId: 'phish', state: 'idle', calls: 0 },
  { agentId: 'c2', state: 'idle', calls: 0 },
  { agentId: 'persistence', state: 'idle', calls: 0 },
  { agentId: 'postex', state: 'idle', calls: 0 },
  { agentId: 'report', state: 'idle', calls: 0 },
];

// ---------------- Spans（L1 折叠单元 / L2 下钻对象） ----------------

export const SPANS: Span[] = [
  {
    id: 'span-a1', agentId: 'recon', title: '组织名解析（orgresolve）',
    status: 'done', startedAt: '02:01', finishedAt: '02:04', toolCalls: 1,
    outputSummary: '3 主域 / 1 ASN / 自有网段',
    reason: '确定授权范围',
  },
  {
    id: 'span-a2', agentId: 'recon', title: '子域枚举 & 存活探测',
    status: 'done', startedAt: '02:04', finishedAt: '02:05', toolCalls: 1,
    outputSummary: '14 子域 / 6 存活 Web / 2 管理后台',
    reason: '攻击面展开',
  },
  {
    id: 'span-a3', agentId: 'recon', title: '端口测绘（203.0.113.0/28）',
    status: 'done', startedAt: '02:05', finishedAt: '02:06', toolCalls: 1,
    outputSummary: '47 开放端口 / 6 主机',
    reason: '服务面补全',
  },
  {
    id: 'span-b', agentId: 'weakcred', title: '弱口令检测（Grafana + OWA + SSH）',
    status: 'done', startedAt: '02:07', finishedAt: '02:10', toolCalls: 1,
    outputSummary: 'Grafana admin/admin 命中（凭据 #c1）',
    reason: 't1 发现登录口，凭据路径优先',
  },
  {
    id: 'span-c', agentId: 'nday', title: 'N-Day 匹配 & 变体验证',
    status: 'done', startedAt: '02:07', finishedAt: '02:11', toolCalls: 2,
    outputSummary: 'CVE-2023-22515 / CVE-2024-21887 confirmed + 1 变体',
    reason: '与 span-b 并行',
  },
  {
    id: 'span-d', agentId: 'exploit', title: '利用链：Confluence 未授权 → RCE',
    status: 'running', startedAt: '02:13', toolCalls: 1,
    outputSummary: 'exploit-chain 执行中…',
    reason: '沙箱 PoC 已过，审批通过',
  },
];

// ---------------- Agent 间消息总线 ----------------

export const MESSAGES: AgentMessage[] = [
  { id: 'm0', ts: '02:01:10', from: 'orchestrator', to: 'all', channel: 'announce', type: 'context', summary: '公告：授权范围未锁定前，禁止一切主动发包动作，仅允许被动信息收集。' },
  { id: 'm1', ts: '02:01:06', from: 'orchestrator', to: 'recon', channel: 'dm', type: 'dispatch', summary: 'orgresolve + 端口测绘（被动优先）', spanId: 'span-a1' },
  { id: 'm2', ts: '02:06:31', from: 'recon', to: 'orchestrator', channel: 'dm', type: 'result', summary: '攻击面快照 + 建议范围', payloadRef: 'ref:t1', spanId: 'span-a3' },
  { id: 'm2b', ts: '02:06:40', from: 'orchestrator', to: 'all', channel: 'announce', type: 'context', summary: '公告：范围已锁定。pay.example-corp.com 为第三方支付，全阶段禁止触达。' },
  { id: 'm3', ts: '02:07:02', from: 'orchestrator', to: 'weakcred', channel: 'dm', type: 'dispatch', summary: '登录口弱口令检测（context: t1 摘要）', spanId: 'span-b' },
  { id: 'm4', ts: '02:07:05', from: 'orchestrator', to: 'nday', channel: 'dm', type: 'dispatch', summary: 'N-Day 模板匹配（context: 指纹清单）', spanId: 'span-c' },
  { id: 'm5', ts: '02:10:40', from: 'weakcred', to: 'all', channel: 'share', type: 'handoff', summary: '情报共享：凭据 #c1 grafana admin/admin（后续横向可复用）', payloadRef: 'cred:#c1', sensitive: true, spanId: 'span-b' },
  { id: 'm6', ts: '02:11:12', from: 'nday', to: 'orchestrator', channel: 'dm', type: 'result', summary: '2 confirmed CVE + PoC 证据', payloadRef: 'ev://a91f…c2', spanId: 'span-c' },
  { id: 'm7', ts: '02:13:02', from: 'orchestrator', to: 'exploit', channel: 'dm', type: 'dispatch', summary: 'CVE-2023-22515 真实验证（审批 #a4 通过）', spanId: 'span-d' },
];

export const fmtTime = '2026-09-06 02:16:12';

// ---------------- CLI 工具 ----------------

export interface CliTool {
  id: string;
  name: string;
  binary: string;         // 二进制路径或命令
  version: string;
  source: 'builtin' | 'local' | 'docker';
  desc: string;
  installed: boolean;
  boundAgents: AgentId[];
  wrapperSkill?: string;  // 包装为哪个 skill 供 agent 调用
}

export const CLI_TOOLS: CliTool[] = [
  { id: 'nuclei', name: 'nuclei', binary: '/usr/local/bin/nuclei', version: 'v3.3.2', source: 'builtin', desc: '模板化漏洞扫描器', installed: true, boundAgents: ['nday'], wrapperSkill: 'nuclei-nday' },
  { id: 'subfinder', name: 'subfinder', binary: '/usr/local/bin/subfinder', version: 'v2.6.6', source: 'builtin', desc: '被动子域枚举', installed: true, boundAgents: ['recon'], wrapperSkill: 'subdomain-enum' },
  { id: 'naabu', name: 'naabu', binary: '/usr/local/bin/naabu', version: 'v2.3.1', source: 'builtin', desc: 'SYN 端口测绘', installed: true, boundAgents: ['recon'], wrapperSkill: 'port-masscan' },
  { id: 'httpx', name: 'httpx', binary: '/usr/local/bin/httpx', version: 'v1.6.8', source: 'builtin', desc: 'HTTP 探活与指纹抓取', installed: true, boundAgents: ['recon'], wrapperSkill: 'web-crawl' },
  { id: 'hydra', name: 'hydra', binary: '/opt/tools/hydra', version: '9.5', source: 'local', desc: '登录口令爆破（限速封装后使用）', installed: true, boundAgents: ['weakcred'], wrapperSkill: 'weakcred-check' },
  { id: 'sqlmap', name: 'sqlmap', binary: 'docker://sqlmap:latest', version: '1.8.3', source: 'docker', desc: 'SQL 注入自动化（容器隔离运行）', installed: true, boundAgents: ['exploit'], wrapperSkill: 'sqli-suite' },
  { id: 'gobuster', name: 'gobuster', binary: '/opt/tools/gobuster', version: 'v3.6', source: 'local', desc: '目录/文件爆破', installed: false, boundAgents: ['recon', 'exploit'] },
  { id: 'frps', name: 'frps', binary: '/opt/tools/frps', version: 'v0.58.1', source: 'local', desc: 'frp 服务端（隧道搭建）', installed: true, boundAgents: ['persistence'], wrapperSkill: 'tunnel-build' },
];

/** Agent 短名（挂载矩阵/归属标签共用） */
export const AGENT_LABEL: Record<AgentId, string> = {
  orchestrator: 'Orchestrator', recon: 'Recon', nday: 'NDay', weakcred: 'WeakCred',
  api: 'API', exploit: 'VulnHunt', phish: 'Phish', c2: 'C2',
  persistence: 'Persistence', postex: 'PostEx', report: 'Report',
  'skill-config': '技能配置', 'mcp-config': 'MCP配置', 'cli-config': 'CLI配置',
};

// ---------------- Span 内部流（L2 下钻内容，数据驱动） ----------------

/** L2 流事件（SessionEvent 的子集形态）：thought/guidance/xagent/tool_call */
export type SpanFlowEvent =
  | { kind: 'thought'; ts: string; body: string }
  | { kind: 'guidance'; ts: string; body: string }
  | { kind: 'xagent'; ts: string; from: string; to: string; channel: 'announce' | 'dm' | 'share'; summary: string; payloadRef?: string; sensitive?: boolean }
  | { kind: 'action'; ts: string; agent: string; cmd: string; output?: string; exitCode?: number; running?: boolean };

export const SPAN_FLOWS: Record<string, SpanFlowEvent[]> = {
  'span-a1': [
    { kind: 'xagent', ts: '02:01:10', from: 'orchestrator', to: 'all', channel: 'announce', summary: '公告：授权范围未锁定前，禁止一切主动发包动作，仅允许被动信息收集。' },
    { kind: 'xagent', ts: '02:01:06', from: 'orchestrator', to: 'recon', channel: 'dm', summary: '对 Example Corp 做组织名解析：工商/WHOIS/crt.sh 三源交叉，被动优先，确定授权范围。' },
    { kind: 'guidance', ts: '02:01:40', body: '范围解析时把子公司和 CDN 共享段排除，只保留自有资产。' },
    { kind: 'thought', ts: '02:01:50', body: '收到。三源交叉时加一步归属校验：证书里的 CDN 泛域名（cloudflare/fastly）剔除，WHOIS 注册人不匹配的关联域剔除。先做纯被动，不碰目标。' },
    { kind: 'action', ts: '02:03:12', agent: 'recon', cmd: 'orgresolve "Example Corp" --crtsh --asn --whois --exclude-cdn', output: `domain   example-corp.com        (whois: 注册人匹配)
domain   example-corp.cn         (crt.sh: SAN 交叉)
domain   example-corp.io         (crt.sh: SAN 交叉)
asn      AS64500                 (whois: 组织名匹配)
netblock 203.0.113.0/28          (ASN 宣告)
skipped  example-corp.cdn.cloudflare.net (共享段，按指导排除)` },
  ],
  'span-a2': [
    { kind: 'xagent', ts: '02:04:02', from: 'orchestrator', to: 'recon', channel: 'dm', summary: '范围已锁定。展开子域枚举：被动聚合 + 解析验证 + httpx 探活抓指纹。' },
    { kind: 'thought', ts: '02:04:05', body: '被动子域枚举聚合四个源，dnsx 验证解析，httpx 探活并抓 title/指纹。' },
    { kind: 'action', ts: '02:04:40', agent: 'recon', cmd: 'subfinder -d example-corp.com -silent | dnsx -a -resp | httpx -title -tech-detect', output: `wiki.example-corp.com      [200] Confluence 8.5.3
grafana.example-corp.com   [200] Grafana 10.2
vpn.example-corp.com       [200] Ivanti 22.3R1
mail/dev/api …             14 subdomains, 6 live web, 2 admin panels` },
    { kind: 'xagent', ts: '02:05:02', from: 'recon', to: 'orchestrator', channel: 'dm', summary: '攻击面快照完成：14 子域 / 6 存活 Web / 2 管理后台（wiki、grafana）', payloadRef: 'ref:t1' },
  ],
  'span-a3': [
    { kind: 'xagent', ts: '02:05:20', from: 'orchestrator', to: 'recon', channel: 'dm', summary: '对 203.0.113.0/28 做 top-1000 端口测绘，速率 50 受约束。' },
    { kind: 'thought', ts: '02:05:30', body: '网段已锁定在授权范围，top-1000 端口 SYN 测绘，速率 50 受约束。' },
    { kind: 'action', ts: '02:06:10', agent: 'recon', cmd: 'naabu -host 203.0.113.0/28 -top-ports 1000 -rate 50', output: `203.0.113.6    22/80/443/8080   (wiki)
203.0.113.9    443/8443         (vpn)
203.0.113.12   25/443/993      (mail)
47 open ports across 6 hosts` },
  ],
  'span-b': [
    { kind: 'xagent', ts: '02:07:02', from: 'orchestrator', to: 'weakcred', channel: 'dm', summary: '登录口弱口令检测：Grafana + OWA + SSH。限速 5/min，启用锁定保护。context: t1 摘要。' },
    { kind: 'guidance', ts: '02:07:30', body: 'OWA 是企业邮箱，账户锁定会影响全员，锁 3 次就停，别按满限速跑。' },
    { kind: 'thought', ts: '02:07:35', body: '收到。OWA 单独收紧策略：连续 3 次 miss 立即中止该目标。先默认凭据库精确匹配（无锁定风险），常见组合限速 5/min。' },
    { kind: 'action', ts: '02:08:15', agent: 'weakcred', cmd: 'weakcred-check --targets grafana,owa,ssh --rate 5/min --lockout-guard --owa-max-miss 3', output: `grafana.example-corp.com   admin:admin        [HIT] 已记录证据 ev://03c4…9a
owa.example-corp.com       3 common creds     [miss] 达中止阈值，停止
ssh  203.0.113.6            8 common creds     [miss] 按限速中止
exit: 1 hit / 3 targets, 0 lockouts` },
    { kind: 'thought', ts: '02:10:42', body: 'Grafana 命中。凭据固化为 #c1 上报主控；该凭据是否可复用到内网，留给 postex 阶段判断。' },
    { kind: 'xagent', ts: '02:10:40', from: 'weakcred', to: 'all', channel: 'share', summary: '情报共享：凭据 #c1 grafana admin/admin（后续横向可复用）', payloadRef: 'cred:#c1', sensitive: true },
  ],
  'span-c': [
    { kind: 'xagent', ts: '02:07:05', from: 'orchestrator', to: 'nday', channel: 'dm', summary: '按指纹清单做 N-Day 模板匹配。命中后一律沙箱复验。context: 指纹清单。' },
    { kind: 'thought', ts: '02:07:20', body: '指纹清单里 Confluence 8.5.3 和 Ivanti 22.3R1 都是 N-Day 高发产品。模板命中后一律进沙箱复验，误报直接反证丢弃。' },
    { kind: 'action', ts: '02:09:44', agent: 'nday', cmd: 'nuclei -l live_web.txt -t cves/ -rl 50 -jsonl -o nday.jsonl', output: `[CVE-2023-22515] wiki.example-corp.com     confluence 8.5.3   [matched]
[CVE-2024-21887]  vpn.example-corp.com      ivanti 22.3R1      [matched]
312 templates / 4 matched` },
    { kind: 'action', ts: '02:10:55', agent: 'nday', cmd: 'poc-verify --sandbox --evidence nday.jsonl', output: `CVE-2023-22515  sandbox uid=0   [confirmed] ev://a91f…c2
CVE-2024-21887  sandbox rce ok  [confirmed] ev://77b0…1d
variant-hunt: confluence patch-diff → 1 疑似未公开变体` },
    { kind: 'xagent', ts: '02:11:12', from: 'nday', to: 'orchestrator', channel: 'dm', summary: '2 confirmed CVE + PoC 证据', payloadRef: 'ev://a91f…c2' },
  ],
  'span-d': [
    { kind: 'xagent', ts: '02:13:02', from: 'orchestrator', to: 'vulnhunt', channel: 'dm', summary: 'CVE-2023-22515 真实验证（审批 #a4 已通过）。注意：allowC2=false，webshell 仅作验证，不建回连。' },
    { kind: 'guidance', ts: '02:13:10', body: '验证完拿到证据就卸掉 webshell，别留东西在目标上。' },
    { kind: 'thought', ts: '02:13:15', body: '收到，执行完即清理：临时管理员账户删除 + 插件卸载 + 访问日志核对。利用链分两步：setup-restore 创建临时管理员 → 插件接口上传 webshell。每步输出写入证据链。' },
    { kind: 'action', ts: '02:13:02', agent: 'vulnhunt', cmd: 'exploit-chain cve-2023-22515 --target wiki.example-corp.com --evidence --cleanup-after', running: true },
  ],
};
