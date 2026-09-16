/**
 * User-facing agent settings: schema + validation + persistence.
 *
 * Two groups (user's design):
 *  - COMMON — one global set shared by every agent (LLM connection,
 *             thinking effort, compaction window…)
 *  - AGENT  — per-agent specialties (this round: recon data-source APIs)
 *
 * Save protocol (user's iron rule): each field saves INDIVIDUALLY and only
 * after a live connectivity test (network fields) or range check (numeric
 * fields). Failed validation → error, nothing persisted.
 *
 * Values live in the prefs store (WAL-durable). NOT to be confused with
 * settings.mjs (spawn policy, pre-existing).
 */
import { getPrefs, setPrefs } from './projects.mjs';
import { CONFIG } from './config.mjs';

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

async function llmProbe(baseUrl, apiKey, model) {
  return probe(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4, stream: false }),
  }, { timeoutMs: 20000 });
}

/* -------- data-source validators (official default base URLs) -------- */
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
        {}, { okCheck: (s, b) => (b && b.error === null ? true : `FOFA: ${b?.errmsg || '认证失败'}`) });
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
    label: 'Censys',
    tier: 'P2', why: '海外视角TLS/证书姊妹域',
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
      return probe(`${RECON_SOURCES.shodan.defaultBase}/api-info?key=${encodeURIComponent(key)}`, {});
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
    tier: 'P1', why: 'DNS历史:僵尸资产走向+CDN源站定位',
    defaultBase: 'https://x.threatbook.com/api',
    fields: { key: 'API Key' },
    async validate({ key }) {
      return probe(`${RECON_SOURCES.threatbook.defaultBase}/v2/whois?apikey=${encodeURIComponent(key)}&domain=example.com`,
        {}, { okCheck: (s, b, t) => ((b && (b.response_code === 0 || b.verbose_msg)) || (s === 200 && t)
          ? true : `微步: ${b?.verbose_msg || '认证失败'}`) });
    },
  },
};

/* ---------------- schema (UI renders from this) ---------------- */
export function settingsSchema() {
  return {
    common: {
      label: '通用配置(全部智能体生效)',
      fields: [
        { id: 'llm.baseUrl', label: 'API Base URL', type: 'text', required: true, placeholder: CONFIG.llmBaseUrl },
        { id: 'llm.apiKey', label: 'API Key', type: 'password', required: true },
        { id: 'llm.model', label: '模型名称', type: 'text', required: true, placeholder: CONFIG.llmModel },
        { id: 'llm.thinkingLevel', label: 'Thinking Effort', type: 'select', options: THINKING_LEVELS, hint: '按所选档位原样传给厂商,不维护厂商映射' },
        { id: 'llm.maxTokens', label: '最大输出 Tokens', type: 'number', check: num(256, 262144), default: 32768 },
        { id: 'llm.contextWindow', label: '上下文窗口 Tokens', type: 'number', check: num(8192, 4194304), default: 786432 },
        { id: 'compaction.enabled', label: '上下文压缩', type: 'select', options: ['开启', '关闭'], default: '开启' },
        { id: 'compaction.reserveTokens', label: '压缩触发预留量(reserveTokens)', type: 'number', check: num(1024, 1048576), default: 16384, hint: '上下文剩余低于该值即触发压缩' },
        { id: 'compaction.keepRecentTokens', label: '压缩保留近期量(keepRecentTokens)', type: 'number', check: num(1024, 1048576), default: 20000 },
      ],
    },
    agents: [
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
        agentKey: 'nday', label: 'NDay Agent · 数据源(只读展示)',
        hint: '本地情报层零 key(cvelistV5/模板库/EPSS 官方 API);GitHub token 在资产测绘组配置后同样对 NDay 生效。',
        sources: [],
      },
      {
        agentKey: 'recon', label: '资产测绘 Agent · 数据源',
        hint: '填好并通过连通验证的源才会挂载为 MCP 工具;未配置的源对 agent 完全不可见(零污染)。Base URL 留空一律使用官方地址。',
        sources: Object.entries(RECON_SOURCES)
          .sort((a, b) => (a[1].tier ?? 'P9').localeCompare(b[1].tier ?? 'P9'))
          .map(([id, s]) => ({
          id, label: s.label, defaultBase: s.defaultBase, tier: s.tier, why: s.why,
          fields: Object.entries(s.fields).map(([fid, flabel]) => ({
            id: `${id}.${fid}`, label: flabel,
            type: fid === 'key' || fid === 'secret' || fid === 'token' ? 'password' : 'text',
          })),
        })),
      },
    ],
  };
}

export function getSettings() {
  const p = getPrefs();
  const bp = p.bruteParams ?? {};
  const reconSources = { ...p.reconApiKeys ?? {} };
  // weakced brute params ride in reconSources under the pseudo-source id
  reconSources.brute = bp;
  return {
    common: p.commonSettings ?? null,
    reconSources,
    schema: settingsSchema(),
  };
}

export async function saveSetting({ group, field, value }, wal) {
  const schema = settingsSchema();
  const clean = (v) => (typeof v === 'string' ? v.trim() : v);

  if (group === 'common') {
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
    const cur = { ...(getPrefs().commonSettings ?? {}) };
    const [top, leaf] = field.split('.');
    cur[top] = { ...(cur[top] ?? {}), [leaf]: def.type === 'number' ? Number(v) : v };
    if (['llm.baseUrl', 'llm.apiKey', 'llm.model'].includes(field)) {
      const merged = { ...defaultsFromEnv(), ...cur.llm };
      const r = await llmProbe(merged.baseUrl, merged.apiKey, merged.model);
      if (!r.ok) return { ok: false, error: `连通失败: ${r.error}` };
    }
    setPrefs({ commonSettings: cur }, wal);
    return { ok: true };
  }

  if (group === 'weakcred') {
    const cur = { ...(getPrefs().bruteParams ?? {}) };
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
    const [srcId, leaf] = field.split('.');
    const src = RECON_SOURCES[srcId];
    if (!src) return { ok: false, error: '未知数据源' };
    const cur = { ...(getPrefs().reconApiKeys?.[srcId] ?? {}), [leaf]: clean(value) };
    const hasSecret = cur.key || cur.token || cur.secret || cur.id;
    const all = { ...(getPrefs().reconApiKeys ?? {}), [srcId]: cur };
    if (!hasSecret) {
      setPrefs({ reconApiKeys: all }, wal);
      return { ok: true, mounted: false };
    }
    const r = await src.validate(cur);
    if (!r.ok) return { ok: false, error: `连通失败: ${r.error}` };
    setPrefs({ reconApiKeys: all }, wal);
    return { ok: true, mounted: true };
  }

  return { ok: false, error: '未知分组' };
}

function defaultsFromEnv() {
  return { baseUrl: CONFIG.llmBaseUrl, apiKey: CONFIG.llmApiKey, model: CONFIG.llmModel };
}

export function effectiveCommon() {
  const cur = getPrefs().commonSettings ?? {};
  const env = defaultsFromEnv();
  return {
    baseUrl: cur.llm?.baseUrl || env.baseUrl,
    apiKey: cur.llm?.apiKey || env.apiKey,
    model: cur.llm?.model || env.model,
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

export function enabledReconSources() {
  const keys = getPrefs().reconApiKeys ?? {};
  const out = [];
  for (const [id, cfg] of Object.entries(keys)) {
    if (id === 'brute' || !RECON_SOURCES[id]) continue;
    if (cfg.key || cfg.token || cfg.secret || cfg.id) out.push(id);
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
