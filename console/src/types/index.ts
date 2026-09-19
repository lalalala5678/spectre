// ============================================================
// SPECTRE Console — 全局类型定义
// 覆盖：阶段 Agent / AutoPwn 编排 / Skill / MCP / 会话与事件流
// ============================================================

/** 渗透阶段路由（侧边栏一级导航） */
export type RouteKey =
  | 'autopwn'        // AutoPwn 一体式自主渗透（Orchestrator 主控）
  | 'recon'          // 资产测绘 & 指纹识别
  | 'nday'           // N-Day & 变体（PoC 验证）
  | 'weakcred'       // 弱口令检测
  | 'api'            // API 渗透
  | 'exploit'        // 漏洞挖掘（SQLi/XSS/配置缺陷等通用 Web 漏洞）
  | 'phish'          // 钓鱼
  | 'c2'             // C2 免杀 & 内存马注入
  | 'persistence'    // 权限维持（隧道搭建等）
  | 'postex'         // 后渗透测试
  | 'report'         // 报告编写
  | 'reports'        // 任务报告(配置/任务闭环交付)
  | 'skills'         // Skill 管理
  | 'mcp'            // MCP Server 管理
  | 'cli'            // CLI 工具导入
  | 'settings'       // Agent 配置栏
  | 'audit'         // 审计与证据链
  | 'shells';        // Shell 控制台

export type AgentId =
  | 'autopwn'
  | 'recon'
  | 'nday'
  | 'weakcred'
  | 'api'
  | 'exploit'
  | 'phish'
  | 'c2'
  | 'persistence'
  | 'postex'
  | 'report'
  | 'skill-config'
  | 'mcp-config'
  | 'cli-config';

export type AgentStatus = 'idle' | 'running' | 'waiting_approval' | 'error' | 'offline';

export interface AgentMeta {
  id: AgentId;
  name: string;
  codename: string;
  desc: string;
  status: AgentStatus;
  model: string;
  skills: string[];      // 已挂载 skill id
  mcpServers: string[];  // 已挂载 mcp server id
  version: string;
}

// ---------------- 会话 / 事件流 ----------------

export type EventKind =
  | 'user'          // 用户输入
  | 'agent_msg'     // agent 文本输出
  | 'tool_call'     // 工具调用（命令/扫描器）
  | 'tool_result'   // 工具结果（结构化）
  | 'approval'      // 危险操作审批请求
  | 'handoff'       // agent 间移交
  | 'vulnerability'  // 漏洞（确定真实危害、可提交）
  | 'intel-note'     // 情报（可能对任务有利的信息）
  | 'file'          // 产物文件
  | 'system'        // 系统提示
  // ---- span 内部流（L2 下钻视图） ----
  | 'thought'       // 思考过程
  | 'guidance'      // 用户对该子 agent 的指导
  | 'xagent';       // 跨智能体消息（频道见 channel）

export interface SessionEvent {
  id: string;
  ts: string;
  kind: EventKind;
  agentId?: AgentId;
  /** 所属子 agent 调用 span（AutoPwn 多 agent 并发时用于分段折叠） */
  spanId?: string;
  title?: string;
  body?: string;            // markdown / 文本
  data?: Record<string, unknown>; // 结构化负载
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info';
  stream?: boolean;         // 是否流式输出中
}

/** 子 Agent 调用 span：L1 主流里的折叠单元，L2 下钻的对象 */
export interface Span {
  id: string;
  agentId: AgentId;
  title: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt?: string;
  toolCalls: number;
  /** 一句话产出摘要（L1 展示） */
  outputSummary?: string;
  /** 触发该 span 的原因（orchestrator 的思考依据） */
  reason?: string;
}

/** agent 间消息（信息传递的一等公民） */
export type MessageChannel =
  | 'announce'  // 公告：主控 → 全员（如范围变更、全局约束）
  | 'dm'        // 私信：点对点（dispatch/result/handoff）
  | 'share';    // 情报共享：某 agent → 广播给相关方（如凭据、攻击面情报）

export interface AgentMessage {
  id: string;
  ts: string;
  from: AgentId;
  to: AgentId | 'all';      // announce/share 时为 all
  channel: MessageChannel;
  type: 'dispatch' | 'result' | 'handoff' | 'context';
  /** payload 摘要；敏感内容只给引用 */
  summary: string;
  payloadRef?: string;      // 如 凭据 #c1 / ev://xxx
  sensitive?: boolean;
  spanId?: string;          // 关联的 span
}

export interface Session {
  id: string;
  title: string;
  target: string;
  agentId: AgentId;
  mode: 'manual' | 'autopwn';
  status: 'active' | 'paused' | 'done' | 'failed';
  createdAt: string;
  events: SessionEvent[];
}

// ---------------- Skill ----------------

export type SkillRisk = 'safe' | 'intrusive' | 'exploit' | 'credential';

export interface Skill {
  id: string;
  name: string;
  source: 'builtin' | 'registry' | 'local';
  version: string;
  desc: string;
  entry: string;             // 入口 SKILL.md / 命令
  risk: SkillRisk;
  enabled: boolean;
  boundAgents: AgentId[];    // 挂载到哪些 agent
  params?: { key: string; required: boolean; desc: string }[];
}

// ---------------- MCP ----------------

export interface McpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  endpoint: string;          // command 或 url
  desc: string;
  status: 'connected' | 'disconnected' | 'error';
  tools: { name: string; desc: string }[];
  boundAgents: AgentId[];
  envKeys: string[];         // 需要的 env key 名（不含值）
}

// ---------------- AutoPwn ----------------

export interface AutoPwnConstraints {
  /** 用户输入的公司/组织名，范围由 Recon Agent 解析 */
  orgName: string;
  /** Recon 建议范围是否已被用户采纳锁定 */
  scopeLocked: boolean;
  allowExploit: boolean;     // 是否允许真实利用
  allowC2: boolean;          // 是否允许落地 C2 / 内存马
  allowPersistence: boolean; // 是否允许权限维持
  rateLimit: number;         // req/s
  timeBudgetMin: number;     // 时间预算
  requireApproval: 'always' | 'exploit+' | 'never';
}

export interface TaskNode {
  id: string;
  stage: AgentId;
  title: string;
  status: 'pending' | 'running' | 'success' | 'blocked' | 'failed' | 'skipped';
  dependsOn: string[];
  /** planned=启动时的计划(可演化)；generated=由运行结果动态生成；hypothetical=仅假设推演 */
  origin: 'planned' | 'generated' | 'hypothetical';
  /** 该节点由哪个运行结果触发（origin=generated 时给出） */
  reason?: string;
  summary?: string;
  startedAt?: string;
  finishedAt?: string;
}

// ---------------- 发现 / 资产 ----------------

export interface Asset {
  id: string;
  type: 'domain' | 'ip' | 'url' | 'service' | 'webapp';
  value: string;
  meta: Record<string, string>;
  source: AgentId;
}

export interface Finding {  // legacy type name (mock data only)
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  target: string;
  evidence: string;
  foundBy: AgentId;
  status: 'new' | 'verified' | 'exploited' | 'false_positive';
  cve?: string;
}

// ---------------- 审计 ----------------

export interface AuditRecord {
  id: string;
  ts: string;
  actor: 'user' | AgentId;
  action: string;
  detail: string;
  approved?: boolean;
  hash: string;
}
