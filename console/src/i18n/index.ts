/** i18n 基建: react-i18next + 懒加载语言包(zh-CN/en-US)。
 * 用法: 组件内 `const { t } = useTranslation()` → `{t('nav.overview')}`。
 * 切换: `i18n.changeLanguage('en-US')`(localStorage 持久化)。 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const zhCN = {
  nav: {
    overview: '总览', autopwn: 'AutoPwn', recon: '资产测绘 & 指纹',
    nday: 'N-Day & 变体', weakcred: '弱口令检测', api: 'API 渗透',
    exploit: '漏洞挖掘', phish: '钓鱼', c2: 'C2 & 内存马',
    persistence: '权限维持', postex: '后渗透', report: '报告编写',
    shells: 'Shell 控制台', reports: '任务报告', skills: 'Skill 管理',
    mcp: 'MCP Server', cli: 'CLI 工具', settings: '设置', audit: '审计与证据链',
  },
  common: {
    running: '运行中', idle: '空闲', loading: '加载中…',
    search: '搜索', clear: '清除', export: '导出', copy: '复制', copied: '已复制',
    back: '返回', confirm: '确认', cancel: '取消', delete: '删除',
    empty: '暂无数据', error: '加载失败', retry: '重试',
    newProject: '新建项目', noProject: '无当前项目',
  },
  vuln: {
    title: '漏洞', severity: '严重程度', none: '暂无漏洞', noMatch: '无匹配漏洞',
    critical: '严重', high: '高危', medium: '中危', low: '低危', info: '信息',
    recentFindings: '最近发现', copyMd: '复制为 Markdown', exportMd: '导出 .md',
  },
  session: {
    busy: '运行中', idle: '空闲', exportSession: '导出会话',
    placeholder: '输入指令…', send: '发送', draftSaved: '草稿已保存',
  },
  overview: {
    title: '总览', campaigns: '进行中的战役', findings: '战果总览',
    activity: '活动流', newCampaign: '新开战役', assets: '资产',
    intel: '情报', reports: '终报', failed: '失败',
    firstCampaign: '开始你的第一场渗透',
    firstHint: '在 AutoPwn 工作台输入目标, 席位自动编排测绘→验证→落账',
  },
};

const enUS: typeof zhCN = {
  nav: {
    overview: 'Overview', autopwn: 'AutoPwn', recon: 'Recon & Fingerprint',
    nday: 'N-Day & Variants', weakcred: 'Weak Credentials', api: 'API Pentest',
    exploit: 'Vuln Hunt', phish: 'Phishing', c2: 'C2 & Memshell',
    persistence: 'Persistence', postex: 'Post-Ex', report: 'Report',
    shells: 'Shell Console', reports: 'Task Reports', skills: 'Skills',
    mcp: 'MCP Server', cli: 'CLI Tools', settings: 'Settings', audit: 'Audit',
  },
  common: {
    running: 'Running', idle: 'Idle', loading: 'Loading…',
    search: 'Search', clear: 'Clear', export: 'Export', copy: 'Copy', copied: 'Copied',
    back: 'Back', confirm: 'Confirm', cancel: 'Cancel', delete: 'Delete',
    empty: 'No data', error: 'Failed to load', retry: 'Retry',
    newProject: 'New Project', noProject: 'No active project',
  },
  vuln: {
    title: 'Vulnerabilities', severity: 'Severity', none: 'No vulnerabilities', noMatch: 'No matches',
    critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info',
    recentFindings: 'Recent Findings', copyMd: 'Copy as Markdown', exportMd: 'Export .md',
  },
  session: {
    busy: 'Running', idle: 'Idle', exportSession: 'Export Session',
    placeholder: 'Type a command…', send: 'Send', draftSaved: 'Draft saved',
  },
  overview: {
    title: 'Overview', campaigns: 'Active Campaigns', findings: 'Findings',
    activity: 'Activity Feed', newCampaign: 'New Campaign', assets: 'Assets',
    intel: 'Intel', reports: 'Reports', failed: 'failed',
    firstCampaign: 'Start Your First Campaign',
    firstHint: 'Enter a target in the AutoPwn workspace — agents auto-orchestrate recon→verify→report',
  },
};

const saved = localStorage.getItem('spectre-lang');
const prefers = navigator.language.startsWith('zh') ? 'zh-CN' : 'en-US';

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS },
  },
  lng: saved ?? prefers,
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
});

export function changeLang(lang: string) {
  localStorage.setItem('spectre-lang', lang);
  void i18n.changeLanguage(lang);
}

export default i18n;
