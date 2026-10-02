/**
 * User-facing agent settings: schema + validation + persistence.
 *
 * Two groups (user's design):
 *  - COMMON — one global set shared by every agent (LLM connection,
 *             thinking effort, compaction window…)
 *  - AGENT  — per-agent specialties (this round: recon data-source APIs)
 *
 * Save protocol (user's iron rule): most fields save per-field with a
 * live connectivity test (network fields) or range check (numeric
 * fields). LLM connectivity is ATOMIC instead (R32D45-N1/CS16-P1):
 * the default vendor (common.llm) and per-agent overrides (agent-llm)
 * both submit all four fields in one request, probed as the complete
 * effective config — failed validation → error, nothing persisted.
 *
 * Values live in the prefs store (WAL-durable). NOT to be confused with
 * settings.mjs (spawn policy, pre-existing).
 */
import { getPrefs, setPrefs } from './projects.mjs';
import { probeSearchProvider } from './sandbox/tooling-probe.mjs';
import { AGENTS } from './agents.mjs';

/** pi canonical thinking levels — passed to the vendor AS-IS. No vendor
 * mapping is maintained here (user decision: 映射交给用户/厂商,不搭中间站). */
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const num = (min, max) => (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false, error: '必须是数字' };
  if (n < min || n > max) return { ok: false, error: `范围 ${min}-${max}` };
  return { ok: true };
};

async function probe(url, init = {}, { timeoutMs = 15000, okCheck } = {}) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* html/text */ }
    if (okCheck) {
      const r = okCheck(res.status, body, text);
      if (r !== true) return { ok: false, error: r || '校验失败' };
    } else if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 120)}` };
    }
    return { ok: true, detail: body };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/* R32D44-llm: 平台统一 LLM 接入的三种线制(用户令: 格式下拉选择)。
 * 探测按线制走各自握手——探测通过才允许落盘(与既有保存协议一致)。 */
export const LLM_FORMATS = {
  openai: {
    label: 'OpenAI 兼容(/chat/completions)',
    hint: 'GLM/DeepSeek/Kimi/Qwen/OpenAI 及绝大多数代理网关',
    api: 'openai-completions',
    probe: (baseUrl, apiKey, model) => probe(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4, stream: false }),
    }, { timeoutMs: 20000 }),
  },
  anthropic: {
    label: 'Anthropic(/v1/messages)',
    hint: 'Claude 系;key 头 x-api-key + anthropic-version',
    api: 'anthropic-messages',
    probe: (baseUrl, apiKey, model) => probe(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens: 4, messages: [{ role: 'user', content: 'ping' }] }),
    }, { timeoutMs: 20000 }),
  },
  gemini: {
    label: 'Google Gemini(:generateContent)',
    hint: 'Gemini 系;key 走 x-goog-api-key 请求头',
    api: 'google-generative-ai',
    probe: (baseUrl, apiKey, model) => probe(
      `${baseUrl.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] }),
      }, { timeoutMs: 20000 }),
  },
};

async function llmProbe(baseUrl, apiKey, model, format = 'openai') {
  const f = LLM_FORMATS[format] ?? LLM_FORMATS.openai;
  return f.probe(baseUrl, apiKey, model);
}

/* -------- data-source validators (official default base URLs) --------
 * Each source declares which agents consume it. A key is persisted ONLY
 * after a live validate() success, and mounted ONLY for the listed agents
 * (zero-pollution: unverifiable source ⇒ agent never sees it). */
const RECON_SOURCES = {
  fofa: {
    label: 'FOFA',
    tier: 'P0', why: '最大盲区补齐:备案反查/无证书vhost/非标端口/历史banner',
    defaultBase: 'https://fofa.info/api',
    fields: { baseUrl: 'Base URL(留空用官方)', email: '账号邮箱', key: 'API Key' },
    async validate({ baseUrl, email, key }) {
      const base = baseUrl || RECON_SOURCES.fofa.defaultBase;
      if (!email || !key) return { ok: false, error: 'FOFA 需要 email + key 两者' };
      return probe(`${base}/v1/info/my?email=${encodeURIComponent(email)}&key=${encodeURIComponent(key)}`,
        // FOFA 成功响应是 "error":false(布尔)而非 null——此前谓词
        // 要求 ===null 把所有有效 key 误判为认证失败(前端实测抓出)。
        {}, { okCheck: (s, b) => (b && (b.error === false || b.error === null) ? true : `FOFA: ${b?.errmsg || '认证失败'}`) });
    },
  },
  hunter: {
    label: '鹰图 Hunter',
    tier: 'P1', why: '国内第二源,与FOFA交叉验证,免费额度大',
    defaultBase: 'https://hunter.qianxin.com/openApi',
    fields: { key: 'API Key' },
    async validate({ key }) {
      return probe(`${RECON_SOURCES.hunter.defaultBase}/search?api-key=${encodeURIComponent(key)}&search=dGVzdA%3D%3D&page=1&page_size=1&is_web=3`,
        {}, { okCheck: (s, b) => (b && b.code === 200 ? true : `Hunter: ${b?.message || '认证失败'}`) });
    },
  },
  quake: {
    label: 'Quake360',
    tier: 'P2', why: '资产第三源,多源并集提覆盖',
    defaultBase: 'https://quake.360.net/api',
    fields: { key: 'API Key' },
    async validate({ key }) {
      const r = await probe(`${RECON_SOURCES.quake.defaultBase}/v3/user/info`, {
        headers: { 'X-QuakeToken': key },
      });
      if (r.ok && r.detail && r.detail.code !== 0) {
        return { ok: false, error: `Quake: ${r.detail.message || '认证失败'}` };
      }
      return r;
    },
  },
  zoomeye: {
    label: 'ZoomEye',
    tier: 'P2', why: '资产第四源',
    defaultBase: 'https://api.zoomeye.org',
    fields: { key: 'API Key' },
    async validate({ key }) {
      return probe(`${RECON_SOURCES.zoomeye.defaultBase}/resources-info`, {
        headers: { 'API-KEY': key },
      });
    },
  },
  censys: {
    label: 'Censys(v2 已 EOL——暂不可配置)',
    // R32D46-NEW-7: v2 API 2026-09-30 停服(/v2/* 现返 404+关停告警),
    // 任何 key 无法过校验。v3 认证形状未定稿(官方迁移文档待出),
    // 先如实标注; 端点形状确认后改 defaultBase+validate。
    tier: 'P2', why: '海外视角TLS/证书姊妹域(v2 已停服, 待 v3 适配)',
    defaultBase: 'https://search.censys.io/api',
    fields: { id: 'API ID', secret: 'API Secret' },
    async validate({ id, secret }) {
      if (!id || !secret) return { ok: false, error: 'Censys 需要 ID + Secret' };
      return probe(`${RECON_SOURCES.censys.defaultBase}/v2/account/headers`, {
        headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` },
      });
    },
  },
  shodan: {
    label: 'Shodan',
    tier: 'P2', why: '海外banner',
    defaultBase: 'https://api.shodan.io',
    fields: { key: 'API Key' },
    async validate({ key }) {
      // 前端实测: 无 okCheck 时 401 走通用分支, 报错带整页 HTML——
      // 给干净的引导性文案(与 censys/vt 等一致)。
      return probe(`${RECON_SOURCES.shodan.defaultBase}/api-info?key=${encodeURIComponent(key)}`,
        {}, { okCheck: s => (s === 200 ? true
          : s === 401 ? 'SHODAN: key 无效'
          : s === 403 ? 'SHODAN: 权限不足' : `HTTP ${s}`) });
    },
  },
  metadefender: {
    label: 'MetaDefender (OPSWAT)',
    tier: 'P1', why: 'C2 免杀多引擎云查(30+ 引擎并集,AVCONDS 威胁评分)',
    defaultBase: 'https://cloud.metadefender.com/api',
    agents: ['c2'],
    fields: { key: 'API Key' },
    async validate({ key, baseUrl }) {
      const base = baseUrl || RECON_SOURCES.metadefender.defaultBase;
      return probe(`${base}/v4/key/${encodeURIComponent(key)}`, {
        headers: { apikey: key },
      }, { okCheck: st => (st === 200 ? true : st === 401 || st === 403 ? 'MetaDefender: key 无效' : `HTTP ${st}`) });
    },
  },
  hybridanalysis: {
    label: 'Hybrid Analysis (Falcon)',
    tier: 'P1', why: 'C2 免杀沙箱云查(VxFamily/威胁分数,免费层)',
    defaultBase: 'https://www.hybrid-analysis.com/api',
    agents: ['c2'],
    fields: { key: 'API Key' },
    async validate({ key, baseUrl }) {
      const base = baseUrl || RECON_SOURCES.hybridanalysis.defaultBase;
      return probe(`${base}/v2/key/current`, {
        headers: { 'api-key': key, 'user-agent': 'spectre' },
      }, { okCheck: (st, b, t) => (st === 200 && b ? true : (b?.message || `HTTP ${st}: ${String(t).slice(0, 80)}`)) });
    },
  },
  nvd: {
    label: 'NVD (NIST)',
    tier: 'P1', why: 'NDay CVE 拉取提速(无 key 5 请求/30s→带 key 50)',
    defaultBase: 'https://services.nvd.nist.gov/rest/json',
    agents: ['nday'],
    fields: { key: 'API Key' },
    async validate({ key, baseUrl }) {
      const base = baseUrl || RECON_SOURCES.nvd.defaultBase;
      return probe(`${base}/cves/2.0?resultsPerPage=1`, {
        headers: { apiKey: key },
      }, { okCheck: (st, b) => (st === 200 && b?.totalResults !== undefined ? true
        : st === 404 || st === 403 ? 'NVD: key 无效或被封禁'
        : b?.message ? `NVD: ${b.message}` : `HTTP ${st}`) });
    },
  },
  virustotal: {
    label: 'VirusTotal',
    tier: 'P1', why: 'C2 免杀多引擎云查(70+引擎并集)',
    defaultBase: 'https://www.virustotal.com/api',
    agents: ['c2'],
    fields: { key: 'API Key' },
    async validate({ key }) {
      return probe(`${RECON_SOURCES.virustotal.defaultBase}/v3/users/${encodeURIComponent(key)}`, {
        headers: { 'x-apikey': key },
      }, { okCheck: (s) => (s === 200 ? true : s === 401 ? 'VT: key 无效' : s === 403 ? 'VT: 权限不足(需高级 key)' : `HTTP ${s}`) });
    },
  },
  github: {
    label: 'GitHub Token',
    tier: 'P0', why: '代码泄露检索(免费),内网地址/密钥',
    defaultBase: 'https://api.github.com',
    fields: { token: 'Personal Access Token' },
    async validate({ token }) {
      return probe(`${RECON_SOURCES.github.defaultBase}/user`, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'spectre' },
      });
    },
  },
  cse: {
    label: 'Google CSE',
    tier: 'P0', why: '文档类OSINT唯一可靠机器通道(全量Google dork语法)',
    defaultBase: 'https://www.googleapis.com',
    fields: { key: 'API Key', cx: '搜索引擎 ID (cx)' },
    async validate({ key, cx }) {
      if (!key || !cx) return { ok: false, error: 'CSE 需要 key + cx' };
      return probe(`${RECON_SOURCES.cse.defaultBase}/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&q=test&num=1`,
        {}, { okCheck: (s, b) => (b && !b.error ? true : `CSE: ${b?.error?.message || '认证失败'}`) });
    },
  },
  ipinfo: {
    label: 'IPinfo',
    tier: 'P1', why: 'IP归属/ASN,C段归属判定(免费)',
    defaultBase: 'https://ipinfo.io',
    fields: { token: 'Token' },
    async validate({ token }) {
      return probe(`${RECON_SOURCES.ipinfo.defaultBase}/json?token=${encodeURIComponent(token)}`, {});
    },
  },
  threatbook: {
    label: '微步在线',
    tier: 'P1', why: 'DNS历史:僵尸资产走向+CDN源站定位;C2 免杀云查(文件信誉)',
    agents: ['recon', 'c2'],
    defaultBase: 'https://x.threatbook.com/api',
    fields: { key: 'API Key' },
    async validate({ key }) {
      return probe(`${RECON_SOURCES.threatbook.defaultBase}/v2/whois?apikey=${encodeURIComponent(key)}&domain=example.com`,
        {}, { okCheck: (s, b, t) => ((b && (b.response_code === 0 || b.verbose_msg)) || (s === 200 && t)
          ? true : `微步: ${b?.verbose_msg || '认证失败'}`) });
    },
  },
  smtp: {
    label: 'SMTP 发信',
    tier: 'P0', why: '钓鱼 agent 邮件发送通道(直连/中继)',
    agents: ['phish'],
    // CS59-F1: allow_plaintext 持久化通道落地(此前 phish-send 降级指
    // 引指向不存在的面板开关——手改 smtp.json 又被整写清除)。
    fields: { host: 'SMTP 主机', port: '端口', user: '账号', password: '密码',
      allow_plaintext: '明文降级(STARTTLS 缺失时)' },
    async validate({ host, port, user, password: _password }) {
      if (!host || !user) return { ok: false, error: 'SMTP 需要 host + user' };
      const p = Number(port) || 587;
      try {
        const net = await import('node:net');
        const ok = await new Promise((resolve) => {
          const sock = net.createConnection({ host, port: p });
          const t = setTimeout(() => { sock.destroy(); resolve(false); }, 8000);
          sock.once('data', (d) => {
            clearTimeout(t); sock.destroy();
            resolve(d.toString().startsWith('220'));
          });
          sock.once('error', () => { clearTimeout(t); resolve(false); });
        });
        if (!ok) return { ok: false, error: `SMTP ${host}:${p} 无响应或非 SMTP banner` };
        return { ok: true, detail: { banner: true } };
      } catch (e) {
        return { ok: false, error: `SMTP 连接失败: ${String(e?.message ?? e).slice(0, 120)}` };
      }
    },
  },
};

export const RECON_SOURCES_INTERNAL = RECON_SOURCES;

/* ---------------- schema (UI renders from this) ---------------- */
export function settingsSchema() {
  return {
    // CS19-4: LLM 供应商四字段(格式/URL/Key/模型)走原子编辑器——选项
    // 与适配说明从这里下发(前端不再硬编码三份副本)。
    llmFormats: Object.entries(LLM_FORMATS).map(([id, f]) => ({
      id, label: f.label, hint: f.hint,
    })),
    common: {
      label: '通用配置(全部智能体生效)',
      fields: [
        { id: 'llm.thinkingLevel', label: 'Thinking Effort', type: 'select', options: THINKING_LEVELS, default: 'low', hint: '按所选档位原样传给厂商,不维护厂商映射' },
        { id: 'llm.maxTokens', label: '最大输出 Tokens', type: 'number', check: num(256, 262144), default: 32768 },
        { id: 'llm.contextWindow', label: '上下文窗口 Tokens', type: 'number', check: num(8192, 4194304), default: 786432 },
        { id: 'compaction.enabled', label: '上下文压缩', type: 'select', options: ['开启', '关闭'], default: '开启' },
        // U2: 通用 web 搜索 provider 从"仅 PUT /api/prefs 裸写"收编进面板——
        // 此前是全平台唯一不经面板的 key 面(消费方 tooling.mjs PROVIDERS)。
        { id: 'webSearch.provider', label: '通用 Web 搜索 Provider', type: 'select',
          options: ['none', 'zhipu', 'brave', 'tavily', 'searxng'], default: 'none',
          hint: '全员 search_web 兜底通道;none=仅垂直通道(MCP registry/GitHub/npm,零 key)且回执如实声明' },  // CS43-N1: pip 通道已删同步
        { id: 'webSearch.apiKey', label: '搜索 API Key', type: 'password',
          hint: 'zhipu(智谱 web_search)/brave/tavily 需要;searxng 自建免 key' },
        { id: 'webSearch.baseUrl', label: 'SearXNG 地址', type: 'text',
          placeholder: 'http://127.0.0.1:8080', hint: '仅 provider=searxng 时使用(JSON API 端点)' },
        { id: 'compaction.reserveTokens', label: '压缩触发预留量(reserveTokens)', type: 'number', check: num(1024, 1048576), default: 16384, hint: '上下文剩余低于该值即触发压缩' },
        { id: 'compaction.keepRecentTokens', label: '压缩保留近期量(keepRecentTokens)', type: 'number', check: num(1024, 1048576), default: 20000 },
      ],
    },
    agents: [
      {
        agentKey: 'c2', label: 'C2 Agent · 免杀云查引擎',
        hint: '填好并通过连通验证的引擎才会写入沙箱 api-keys.json 供 c2-qa 调用;未配置/校验失败对 agent 完全不可见(零污染)。微步在「资产测绘」组配置后此处同步生效。',
        sources: Object.entries(RECON_SOURCES)
          .filter(([sid, sv]) => (sv.agents ?? ['recon']).includes('c2') && sid !== 'smtp')
          .map(([id, sv]) => ({
            id, label: sv.label, defaultBase: sv.defaultBase, tier: sv.tier, why: sv.why,
            fields: Object.entries(sv.fields).map(([fid, flabel]) => reconField(id, fid, flabel)),
          })),
      },
      {
        agentKey: 'phish', label: '钓鱼 Agent · 发信通道',
        hint: 'SMTP 通过 banner 探测后才写入沙箱 smtp.json(默认通道);凭据永不回显。',
        sources: Object.entries(RECON_SOURCES)
          .filter(([, sv]) => (sv.agents ?? ['recon']).includes('phish'))
          .map(([id, sv]) => ({
            id, label: sv.label, defaultBase: sv.defaultBase ?? '', tier: sv.tier, why: sv.why,
            fields: Object.entries(sv.fields).map(([fid, flabel]) => reconField(id, fid, flabel)),
          })),
      },
      {
        agentKey: 'weakcred', label: '爆破 Agent · 爆破参数(实时生效)',
        hint: '防锁定参数与字典选择,保存后对新会话生效(注入系统提示词)。',
        sources: [{
          id: 'brute', label: '爆破约束', defaultBase: '',
          fields: [
            { id: 'brute.delaySec', label: '每账号尝试间隔(秒)', type: 'number', check: num(1, 120), default: 3, hint: '防锁定:登录面每账号两次尝试之间的最小间隔' },
            { id: 'brute.maxConc', label: '单登录面并发', type: 'number', check: num(1, 16), default: 2 },
            { id: 'brute.lockBudget', label: '单账号错误预算(锁定阈值内)', type: 'number', check: num(1, 50), default: 5, hint: '先探测锁定策略,预算内行动' },
            { id: 'brute.hydraThreads', label: '服务爆破线程(hydra -t)', type: 'number', check: num(1, 32), default: 4 },
            { id: 'brute.dirWordlist', label: '目录爆破字典', type: 'select', options: ['common', 'medium', 'raft'], default: 'common', hint: 'common=SecLists common.txt;medium=directory-list-2.3-medium;raft=raft-words' },
            { id: 'brute.baseWords', label: '语义基词(逗号分隔)', type: 'text', default: '', placeholder: 'gzpyp,gzpy,admin,service,jiaowu', hint: 'hashcat 规则管道首段基词:学校缩写/服务名/年份等,留空用默认集' },
            { id: 'brute.userDict', label: '用户名字典', type: 'select', options: ['auto', 'xato', 'pinyin', 'staff-id'], default: 'auto', hint: 'auto=按面自适应;xato=英文top;pinyin=姓名拼音;staff-id=工号/学号' },
            { id: 'brute.passDict', label: '密码策略', type: 'select', options: ['both', 'semantic', 'rockyou'], default: 'both', hint: 'both=语义管道+rockyou 串行;semantic=仅 hashcat 规则管道;rockyou=仅字典' },
          ],
        }],
      },
      {
        agentKey: 'nday', label: 'NDay Agent · 情报源',
        hint: '本地情报层零 key(cvelistV5/模板库/EPSS);NVD key 提速 CVE 拉取;GitHub token 在资产测绘组配置后同样生效。',
        sources: Object.entries(RECON_SOURCES)
          .filter(([, sv]) => (sv.agents ?? ['recon']).includes('nday'))
          .map(([id, sv]) => ({
            id, label: sv.label, defaultBase: sv.defaultBase, tier: sv.tier, why: sv.why,
            fields: Object.entries(sv.fields).map(([fid, flabel]) => reconField(id, fid, flabel)),
          })),
      },
      {
        agentKey: 'recon', label: '资产测绘 Agent · 数据源',
        hint: '填好并通过连通验证的源才会挂载为 MCP 工具;未配置的源对 agent 完全不可见(零污染)。Base URL 留空一律使用官方地址。',
        sources: Object.entries(RECON_SOURCES)
          .filter(([, sv]) => (sv.agents ?? ['recon']).includes('recon'))
          .sort((a, b) => (a[1].tier ?? 'P9').localeCompare(b[1].tier ?? 'P9'))
          .map(([id, s]) => ({
          id, label: s.label, defaultBase: s.defaultBase, tier: s.tier, why: s.why,
          fields: Object.entries(s.fields).map(([fid, flabel]) => reconField(id, fid, flabel)),
        })),
      },
    ],
    // R32D44-llm: 每 agent 的 LLM 覆盖(默认供应商之上按 agent 换厂商/
    // 模型——例: 默认 GLM, 报告 agent 改 DeepSeek)。字段留空=继承默认。
    agentLlm: AGENTS.map(a => ({
      agentKey: a.key, label: `${a.name} · ${a.role}`,
      hint: '留空=继承默认大模型供应商;填写后此 agent 单独走该供应商(保存前真实连通校验)。',
      fields: [
        { id: 'format', label: '接口格式', type: 'select', options: ['', ...Object.keys(LLM_FORMATS)], hint: '空=继承默认' },
        { id: 'baseUrl', label: 'API Base URL', type: 'text' },
        { id: 'apiKey', label: 'API Key', type: 'password' },
        { id: 'model', label: '模型名称', type: 'text' },
      ],
    })),
  };
}


/**
 * 凭据类字段名判定(CS3-N14: 四处逐字谓词漂移收敛——c2 组含 password
 * 而 nday/recon 组漏, 'password' 字段在彼组会渲染为明文 text)。
 */
const CRED_FIELD = new Set(['key', 'secret', 'token', 'password']);
const fieldTypeOf = fid => (CRED_FIELD.has(fid) ? 'password' : 'text');
// CS59-F1: recon 源字段 def 单源(三处 schema map 此前各写一份)。
const reconField = (sid, fid, flabel) => (fid === 'allow_plaintext'
  ? { id: `${sid}.${fid}`, label: flabel, type: 'select', options: ['true', 'false'], default: 'false',
      hint: 'true=中继无 STARTTLS 时允许明文降级(明文发 AUTH 凭据, 仅限本地授权靶)' }
  : { id: `${sid}.${fid}`, label: flabel, type: fieldTypeOf(fid) });

// R32D59-N6: 凭据读面掩码(••••+尾4)/写面掩码哨兵还原——多账号共享
// 机下低权登录者不再能读管理员 LLM Key 全文; 保存表单原样回传掩码时
// 解析回存量, 探测/落盘用真值(掩码哨兵撞真钥概率≈0, 且以尾4校验)。
export const MASK = '••••';
export function maskSecret(v) {
  return (typeof v === 'string' && v.length > 4) ? MASK + v.slice(-4) : (v ? MASK : v);
}
function unmaskSecret(stored, incoming) {
  if (typeof incoming !== 'string' || !incoming.startsWith(MASK)) return incoming;
  const real = typeof stored === 'string' ? stored : '';
  // R32D60-NEW3: 掩码形但不匹配存量(粘贴了别处掩码/存量已清)——
  // 返回 null 由调用方显式拒绝, 不得把字面掩码串落库。
  return incoming === maskSecret(real) ? real : null;
}

export function getSettings() {
  const p = getPrefs();
  const bp = p.bruteParams ?? {};
  // CS37-F1 修正: 掩码下钻到叶(此前整源字典塌成 '••••' 字符串, 全字段
  // 回显空+徽标误报)。仅凭据叶掩码(isSecretLeaf 单源谓词);
  // baseUrl/email/id 等非凭据叶原样回显。
  const maskSrc = (o, srcId) => Object.fromEntries(Object.entries(o ?? {}).map(([fk, fv]) =>
    [fk, (isSecretLeaf(srcId, fk)
          || (fv && typeof fv === 'string' && fv.startsWith(MASK)))
      ? maskSecret(fv) : fv]));
  const reconSources = Object.fromEntries(
    Object.entries({ ...p.reconApiKeys }).map(([k, v]) => [k, maskSrc(v, k)]));
  // weakcred brute params ride in reconSources under the pseudo-source id(CS3-N14 拼写)
  reconSources.brute = bp;
  const maskLlm = (cfg) => (cfg && typeof cfg === 'object')
    ? { ...cfg, apiKey: cfg.apiKey ? maskSecret(cfg.apiKey) : cfg.apiKey } : cfg;
  const common = p.commonSettings ? {
    ...p.commonSettings,
    llm: maskLlm(p.commonSettings.llm),
    webSearch: p.commonSettings.webSearch
      ? { ...p.commonSettings.webSearch,
          apiKey: p.commonSettings.webSearch.apiKey ? maskSecret(p.commonSettings.webSearch.apiKey) : p.commonSettings.webSearch.apiKey }
      : p.commonSettings.webSearch,
  } : null;
  const agentLlm = Object.fromEntries(
    Object.entries(p.agentLlm ?? {}).map(([k, v]) => [k, maskLlm(v)]));
  return { common, agentLlm, reconSources, schema: settingsSchema() };
}

export async function saveSetting({ group, field, value }, wal) {
  const schema = settingsSchema();
  const clean = (v) => (typeof v === 'string' ? v.trim() : v);

  if (group === 'common') {
    // R32D45-N1: llm 四字段(格式/URL/Key/模型)原子提交——与 agent-llm
    // 同协议。此前逐字段保存×合并探测存在同款跨厂商死锁: 换默认供应
    // 商时先存 baseUrl 的瞬间=新 URL+旧 key→探测 401 存不进(唯一逃生
    // 是先清 key, UI/文档均无提示)。value 为四字段对象; 其余 common
    // 字段仍走下方逐字段路径。
    if (field === 'llm' && typeof value === 'object' && value !== null) {
      const raw = value;
      if (['format', 'baseUrl', 'apiKey', 'model'].some(k => typeof raw[k] !== 'string')) {
        return { ok: false, error: 'value 须为 { format, baseUrl, apiKey, model } 四字符串字段' };
      }
      // CS19-3: 与 agent-llm 原子路径同款 trim(粘贴带尾随空格的 URL
      // 此前原样落盘)。
      const ak = unmaskSecret(getPrefs().commonSettings?.llm?.apiKey, raw.apiKey.trim());
      if (ak === null) return { ok: false, error: 'API Key 为掩码形态且与存量不符——粘贴完整值或清空后保存' };
      const v4 = {
        format: raw.format.trim(),
        baseUrl: raw.baseUrl.trim(),
        apiKey: ak,
        model: raw.model.trim(),
      };
      if (v4.format && !Object.keys(LLM_FORMATS).includes(v4.format)) {
        return { ok: false, error: `格式必须是 ${Object.keys(LLM_FORMATS).join('/')}` };
      }
      if (!v4.baseUrl || !v4.apiKey || !v4.model) {
        return { ok: false, error: '默认供应商三项必填(Base URL/API Key/模型)' };
      }
      const r = await llmProbe(v4.baseUrl, v4.apiKey, v4.model, v4.format || 'openai');
      if (!r.ok) return { ok: false, error: `连通失败: ${r.error}` };
      const fresh = { ...getPrefs().commonSettings };
      fresh.llm = { ...fresh.llm, format: v4.format || 'openai',
        baseUrl: v4.baseUrl, apiKey: v4.apiKey, model: v4.model };
      setPrefs({ commonSettings: fresh }, wal);
      return { ok: true };
    }
    const def = schema.common.fields.find(f => f.id === field);
    if (!def) return { ok: false, error: '未知配置项' };
    const v = clean(value);
    if (def.type === 'number') {
      const c = def.check(v);
      if (!c.ok) return c;
    }
    if (def.type === 'select' && !def.options.includes(v)) {
      return { ok: false, error: `必须是 ${def.options.join('/')}` };
    }
    // R30: webSearch.apiKey 保存前校验 provider 连通——坏 key 此前
    // 直接落盘, 搜索回执把 401 吞成"0 命中"(api agent 四轮实测抓出)。
    let vRaw = (field === 'webSearch.apiKey')
      ? unmaskSecret(getPrefs().commonSettings?.webSearch?.apiKey, v) : v;
    if (vRaw === null) return { ok: false, error: 'API Key 为掩码形态且与存量不符——粘贴完整值或清空后保存' };
    if (field === 'webSearch.apiKey' && vRaw) {
      const ws = { ...getPrefs().commonSettings?.webSearch, apiKey: vRaw };
      if (ws.provider && ws.provider !== 'none' && ws.provider !== 'searxng') {
        const r = await probeSearchProvider(ws.provider, ws);
        if (!r.ok) return { ok: false, error: `连通失败: ${r.error}` };
      }
    }
    const [top, leaf] = field.split('.');
    const leafVal = def.type === 'number' ? Number(v) : vRaw;
    // R10-F2: probe 是 20s 网络窗口——窗口后重读 prefs 只合并本叶子,
    // 并发保存的另一字段不被陈旧快照覆盖。
    const fresh = { ...getPrefs().commonSettings };
    fresh[top] = { ...fresh[top], [leaf]: leafVal };
    setPrefs({ commonSettings: fresh }, wal);
    return { ok: true };
  }

  if (group === 'agent-llm') {
    // R32D44-llm/CS16-P1: 原子提交协议——value 必须是四字段整体对象
    // (format/baseUrl/apiKey/model, 空串=清除该项回默认)。此前逐字段
    // 保存×整体探测存在中间态死锁: 从 GLM 切 DeepSeek 时先存 baseUrl
    // 的瞬间=新 URL+旧 key→探测 401→永远存不进去(仅同 key 网关可配)。
    // 单请求整体探测+整体落盘, 探测失败零落盘(无回滚问题)。
    // R10-F2 对齐: probe 是 20s 网络窗口, 窗口后重读 prefs 再合并写回,
    // 并发保存的兄弟 agent 不被陈旧快照覆盖。
    const agentKey = field;
    const groupDef = schema.agentLlm.find(g => g.agentKey === agentKey);
    if (!groupDef) return { ok: false, error: '未知 agent' };
    const raw = (typeof value === 'object' && value !== null) ? value : null;
    if (!raw || ['format', 'baseUrl', 'apiKey', 'model'].some(k => typeof raw[k] !== 'string')) {
      return { ok: false, error: 'value 须为 { format, baseUrl, apiKey, model } 四字符串字段(空串=清除)' };
    }
    const ak = unmaskSecret(getPrefs().agentLlm?.[agentKey]?.apiKey ?? effectiveCommon().apiKey, raw.apiKey.trim());
    if (ak === null) return { ok: false, error: 'API Key 为掩码形态且与存量不符——粘贴完整值或清空后保存' };
    const cur = {
      format: raw.format.trim(),
      baseUrl: raw.baseUrl.trim(),
      apiKey: ak,
      model: raw.model.trim(),
    };
    if (cur.format && !Object.keys(LLM_FORMATS).includes(cur.format)) {
      return { ok: false, error: `格式必须是 ${Object.keys(LLM_FORMATS).join('/')}` };
    }
    const anySet = cur.format || cur.baseUrl || cur.apiKey || cur.model;
    if (anySet) {
      // 探测用「覆盖后」的生效配置(默认之上按字段覆盖)
      const base = effectiveCommon();
      const eff = {
        format: cur.format || base.format,
        baseUrl: cur.baseUrl || base.baseUrl,
        apiKey: cur.apiKey || base.apiKey,
        model: cur.model || base.model,
      };
      if (!eff.baseUrl || !eff.apiKey || !eff.model) {
        return { ok: false, error: '生效配置不完整(Base URL/Key/模型)——先在通用配置配好默认, 或把覆盖四字段填齐' };
      }
      const r = await llmProbe(eff.baseUrl, eff.apiKey, eff.model, eff.format);
      if (!r.ok) return { ok: false, error: `连通失败: ${r.error}` };
    }
    const freshAll = { ...getPrefs().agentLlm };
    const cleaned = Object.fromEntries(Object.entries(cur).filter(([, v2]) => v2 !== ''));
    if (Object.keys(cleaned).length === 0) delete freshAll[agentKey];
    else freshAll[agentKey] = cleaned;
    setPrefs({ agentLlm: freshAll }, wal);
    return { ok: true };
  }

  if (group === 'weakcred') {
    const cur = { ...getPrefs().bruteParams };
    const [top, leaf] = field.split('.');
    if (top !== 'brute') return { ok: false, error: '未知配置项' };
    const v = Number(clean(value));
    if (['delaySec', 'maxConc', 'lockBudget', 'hydraThreads'].includes(leaf)) {
      if (!Number.isFinite(v) || v < 1) return { ok: false, error: '必须 ≥1' };
      cur[leaf] = v;
    } else if (leaf === 'dirWordlist') {
      if (!['common', 'medium', 'raft'].includes(String(clean(value)))) return { ok: false, error: 'common/medium/raft' };
      cur[leaf] = String(clean(value));
    } else if (leaf === 'userDict') {
      if (!['auto', 'xato', 'pinyin', 'staff-id'].includes(String(clean(value)))) return { ok: false, error: 'auto/xato/pinyin/staff-id' };
      cur[leaf] = String(clean(value));
    } else if (leaf === 'passDict') {
      if (!['both', 'semantic', 'rockyou'].includes(String(clean(value)))) return { ok: false, error: 'both/semantic/rockyou' };
      cur[leaf] = String(clean(value));
    } else if (leaf === 'baseWords') {
      cur[leaf] = String(clean(value)).slice(0, 500);
    } else return { ok: false, error: '未知配置项' };
    setPrefs({ bruteParams: cur }, wal);
    return { ok: true };
  }
  if (group === 'recon-source') {
    // R32D46-NEW-5/CS20/R32D47-P3: 畸形 field 守卫——无点(leaf=undefined
    // 垃圾)、尾点(leaf='')、多点(a.b.c 静默截断落错字段)全拒; 叶子须在
    // 该源 schema 字段集内(secretX 之类未知名此前静默落盘)。
    if (!/^[^.\s]+\.[^.\s]+$/.test(field)) {
      return { ok: false, error: 'field 须为 <sourceId>.<leaf> 形状(单点两侧非空)' };
    }
    const [srcId, leaf] = field.split('.');
    const src = RECON_SOURCES[srcId];
    if (!src) return { ok: false, error: '未知数据源' };
    if (!Object.keys(src.fields ?? {}).includes(leaf)) {
      return { ok: false, error: `未知字段 ${leaf}(该源字段: ${Object.keys(src.fields ?? {}).join('/')})` };
    }
    // R32D59-N6: 掩码哨兵还原(读面已掩码, 表单原样回传不毁真钥);
    // R32D60-NEW3: 掩码形不匹配存量→显式拒绝(不得字面落库)。
    const leafVal = unmaskSecret(getPrefs().reconApiKeys?.[srcId]?.[leaf], clean(value));
    if (leafVal === null) return { ok: false, error: `${leaf} 为掩码形态且与存量不符——粘贴完整值或清空后保存` };
    // R32D47-P3: 空串=删键(此前残留 "a":"" 空串键, 状态不整洁)。
    const prev = { ...getPrefs().reconApiKeys?.[srcId] };
    const cur = leafVal === '' ? (() => { const c2 = { ...prev }; delete c2[leaf]; return c2; })()
      : { ...prev, [leaf]: leafVal };
    // R10-F1: id 不算 secret——censys.id 参数化(同 cse.cx), 先存免探
    // 测落盘; 此前含 cur.id 使 censys 逐字段保存永久死锁(任一先存都
    // 触发双字段整体验证)。
    const hasSecret = hasSourceCredential(cur, srcId);
    if (!hasSecret) {
      const all0 = { ...getPrefs().reconApiKeys };
      if (Object.keys(cur).length === 0) delete all0[srcId];  // R32D48: 源级空对象不留
      else all0[srcId] = cur;
      setPrefs({ reconApiKeys: all0 }, wal);
      return { ok: true, mounted: false };
    }
    const r = await src.validate(cur);
    if (!r.ok) return { ok: false, error: `连通失败: ${r.error}` };
    // R10-F2: validate(~15s 网络窗口)后重读——并发保存的兄弟字段不被
    // 陈旧快照覆盖(丢更新)。
    const freshAll = { ...getPrefs().reconApiKeys };
    if (Object.keys(cur).length === 0) delete freshAll[srcId];  // R32D48: 源级空对象不留
    else freshAll[srcId] = cur;  // CS22-F2: 探测过的 cur(空键已删)
    setPrefs({ reconApiKeys: freshAll }, wal);
    return { ok: true, mounted: true };
  }

  return { ok: false, error: '未知分组' };
}

/* R32D44-llm: .env 直连 LLM 的旧通道已删(用户令: 统一平台配置防双源
 * 污染)——未配置即未配置, 由 pi 层 fail-fast 明示, 不再静默回退 env。 */

/** R32D44-llm: 一次性迁移——旧装机 .env 里的 LLM_* 在首次启动时导入
 * 平台配置(prefs), 此后 env 完全失效(纯单源)。幂等: prefs 已有三元组
 * 或 env 无值即跳过; 迁移动作留痕在 prefs.commonSettings.llm.migratedFromEnv。 */
export function migrateLegacyLlmEnv(wal) {
  const cur = (getPrefs().commonSettings ?? {}).llm ?? {};
  const env = {
    baseUrl: process.env.LLM_BASE_URL || '',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || '',
  };
  const haveAll = cur.baseUrl && cur.apiKey && cur.model;
  const envAny = env.baseUrl || env.apiKey || env.model;
  if (haveAll || !envAny || cur.migratedFromEnv) return false;
  const merged = {
    ...cur,
    baseUrl: cur.baseUrl || env.baseUrl,
    apiKey: cur.apiKey || env.apiKey,
    model: cur.model || env.model,
    migratedFromEnv: true,
  };
  const fresh = { ...getPrefs().commonSettings, llm: merged };
  setPrefs({ commonSettings: fresh }, wal);
  return true;
}
export function effectiveCommon() {
  const cur = getPrefs().commonSettings ?? {};
  return {
    format: cur.llm?.format || 'openai',
    baseUrl: cur.llm?.baseUrl || '',
    apiKey: cur.llm?.apiKey || '',
    model: cur.llm?.model || '',
    thinkingLevel: cur.llm?.thinkingLevel || 'low',
    maxTokens: Number(cur.llm?.maxTokens) || 32768,
    contextWindow: Number(cur.llm?.contextWindow) || 786432,
    compaction: {
      enabled: (cur.compaction?.enabled ?? '开启') === '开启',
      reserveTokens: Number(cur.compaction?.reserveTokens) || 16384,
      keepRecentTokens: Number(cur.compaction?.keepRecentTokens) || 20000,
    },
  };
}

/** CS17-4: 凭据谓词单源——凭据型字段=key/token/secret/password(+组特例
 * smtp.user); id/cx 是参数型字段不算凭据(R10-F1)。save/verify/
 * enabledReconSources/keyfiles/前端 SourceCard/mountedCount 六处此前
 * 六种口径(注释还自称'同口径')。 */
/** CS38-G7: 凭据叶谓词单源(CRED_FIELD 集合 + smtp.user 特例)——掩码
 * 面/徽标面(hasSourceCredential)共用同一词源, 不再平行编码。 */
export function isSecretLeaf(srcId, leaf) {
  return CRED_FIELD.has(leaf) || (srcId === 'smtp' && leaf === 'user');
}

export function hasSourceCredential(cfg, srcId) {
  if (!cfg) return false;
  // CS39-3: 词源接 isSecretLeaf 单源(此前平行枚举, 注释却自称共用)。
  return Object.entries(cfg).some(([k, v]) => v && isSecretLeaf(srcId, k));
}

/** R32D44-llm: 某 agent 的生效 LLM 配置=默认之上按字段覆盖。 */
export function effectiveLlmFor(agentKey) {
  const base = effectiveCommon();
  const ov = (getPrefs().agentLlm ?? {})[agentKey] ?? {};
  return {
    ...base,
    format: ov.format || base.format,
    baseUrl: ov.baseUrl || base.baseUrl,
    apiKey: ov.apiKey || base.apiKey,
    model: ov.model || base.model,
  };
}

export function enabledReconSources() {
  const keys = getPrefs().reconApiKeys ?? {};
  const out = [];
  for (const [id, cfg] of Object.entries(keys)) {
    if (id === 'brute' || !RECON_SOURCES[id]) continue;
    if (hasSourceCredential(cfg, id)) out.push(id);
  }
  return out;
}

/** Effective brute params with defaults (injected into weakcred prompts). */
export function effectiveBruteParams() {
  const bp = getPrefs().bruteParams ?? {};
  const wl = { common: '/opt/tools/seclists/Discovery/Web-Content/common.txt',
    medium: '/opt/tools/seclists/Discovery/Web-Content/directory-list-2.3-medium.txt',
    raft: '/opt/tools/seclists/Discovery/Web-Content/raft-medium-words.txt' };
  return {
    delaySec: Number(bp.delaySec) || 3,
    maxConc: Number(bp.maxConc) || 2,
    lockBudget: Number(bp.lockBudget) || 5,
    hydraThreads: Number(bp.hydraThreads) || 4,
    dirWordlist: wl[bp.dirWordlist] ?? wl.common,
    baseWords: typeof bp.baseWords === 'string' && bp.baseWords.trim()
      ? bp.baseWords.split(/[,，\s]+/).filter(Boolean).slice(0, 32)
      : ['password', 'admin', 'service', 'redis', 'china', 'secret', 'api', 'manager', 'root', 'test'],
    userDict: bp.userDict ?? 'auto',
    passDict: bp.passDict ?? 'both',
  };
}
