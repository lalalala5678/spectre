/** Console 共享类型——仅存活的消费面(CS3-N6: mock 时代 ~130 行死类型
 * 已清, 含与 McpPage 局部类型同名冲突的 McpServer)。 */
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
  | 'shells'         // Shell 控制台
  // R32D39-N1: 配置三键是 agent 会话路由(搜索深链可直达)
  | 'skill-config'
  | 'mcp-config'
  | 'cli-config';

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


export interface AgentMeta {
  id: AgentId;
  name: string;
  codename: string;
  desc: string;
}

export type MessageChannel =
  | 'announce'  // 公告：主控 → 全员（如范围变更、全局约束）
  | 'dm'        // 私信：点对点（dispatch/result/handoff）
  | 'share';    // 情报共享：某 agent → 广播给相关方（如凭据、攻击面情报）

