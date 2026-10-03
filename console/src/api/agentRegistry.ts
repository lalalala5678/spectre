import type { AgentMeta } from '../types';

export const AGENTS: AgentMeta[] = [
  {
    id: 'autopwn',
    name: 'Orchestrator',
    codename: 'AutoPwn 主控',
    desc: '输入目标后自动规划任务并调度各专项智能体执行，全程向你汇报。',
  },
  {
    id: 'recon',
    name: 'Recon Agent',
    codename: '资产测绘 & 指纹',
    desc: '子域枚举、端口测绘、Web 资产发现、指纹/CMS/中间件识别、攻击面建模。',
  },
  {
    id: 'nday',
    name: 'NDay Agent',
    codename: 'N-Day & 变体',
    desc: 'N-Day 漏洞匹配、变种发现、PoC 沙箱验证与误报反证。',
  },
  {
    id: 'weakcred',
    name: 'WeakCred Agent',
    codename: '弱口令检测',
    desc: '服务/后台弱口令检测、默认凭据库匹配、已获凭据跨服务复用测试。',
  },
  {
    id: 'api',
    name: 'API Agent',
    codename: 'API 渗透',
    desc: 'API 资产发现、Schema 还原、越权/注入/业务逻辑漏洞测试。',
  },
  {
    id: 'exploit',
    name: 'VulnHunt Agent',
    codename: '漏洞挖掘',
    desc: '通用 Web 漏洞利用：SQL 注入、XSS、文件上传、路径穿越、配置缺陷（管理页/调试端点/.git 泄露）等，除 API/弱口令/N-Day 外的漏洞路径。',
  },
  {
    id: 'phish',
    name: 'Phish Agent',
    codename: '钓鱼',
    desc: '钓鱼页面克隆、钓鱼邮件生成、凭据收割通道与回传。',
  },
  {
    id: 'c2',
    name: 'C2 Agent',
    codename: 'C2 免杀 & 内存马',
    desc: '载荷免杀处理、内存马注入（Filter/Listener/Agent），通道建立。',
  },
  {
    id: 'persistence',
    name: 'Persistence Agent',
    codename: '权限维持',
    desc: '隧道搭建（frp/iodine/sshuttle）、计划任务、凭据持久化。',
  },
  {
    id: 'postex',
    name: 'PostEx Agent',
    codename: '后渗透',
    desc: '内网横向、凭据收集、敏感数据定位、域渗透路径推演。',
  },
  {
    id: 'report',
    name: 'Report Agent',
    codename: '报告编写',
    desc: '证据链汇总、CVSS 定级、复现步骤编排，输出可交付渗透报告。',
  },
  {
    id: 'skill-config',
    name: 'Skill Config Agent',
    codename: '技能配置',
    desc: '为指定智能体配置 skill:链接下载、上传包、从零撰写。',
  },
  {
    id: 'mcp-config',
    name: 'MCP Config Agent',
    codename: 'MCP配置',
    desc: '为指定智能体配置 MCP server:注册、连通测试、挂载。',
  },
  {
    id: 'cli-config',
    name: 'CLI Config Agent',
    codename: 'CLI配置',
    desc: '向共享沙箱环境安装 CLI 工具(装一次全体智能体可用)。',
  },
];
