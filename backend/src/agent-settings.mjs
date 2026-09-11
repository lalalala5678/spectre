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
    defaultBase: 'https://hunter.qianxin.com/openApi',
    fields: { key: 'API Key' },
    async validate({ key }) {
      return probe(`${RECON_SOURCES.hunter.defaultBase}/search?api-key=${encodeURIComponent(key)}&search=dGVzdA%3D%3D&page=1&page_size=1&is_web=3`,
        {}, { okCheck: (s, b) => (b && b.code === 200 ? true : `Hunter: ${b?.message || '认证失败'}`) });
    },
  },
  quake: {
    label: 'Quake360',
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
    defaultBase: 'https://api.shodan.io',
    fields: { key: 'API Key' },
    async validate({ key }) {
      return probe(`${RECON_SOURCES.shodan.defaultBase}/api-info?key=${encodeURIComponent(key)}`, {});
    },
  },
  github: {
    label: 'GitHub Token',
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
    defaultBase: 'https://ipinfo.io',
    fields: { token: 'Token' },
    async validate({ token }) {
      return probe(`${RECON_SOURCES.ipinfo.defaultBase}/json?token=${encodeURIComponent(token)}`, {});
    },
  },
  threatbook: {
    label: '微步在线',
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
        agentKey: 'recon', label: '资产测绘 Agent · 数据源',
        hint: '填好并通过连通验证的源才会挂载为 MCP 工具;未配置的源对 agent 完全不可见(零污染)。Base URL 留空一律使用官方地址。',
        sources: Object.entries(RECON_SOURCES).map(([id, s]) => ({
          id, label: s.label, defaultBase: s.defaultBase,
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
  return {
    common: p.commonSettings ?? null,
    reconSources: p.reconApiKeys ?? {},
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
    if (!RECON_SOURCES[id]) continue;
    if (cfg.key || cfg.token || cfg.secret || cfg.id) out.push(id);
  }
  return out;
}
