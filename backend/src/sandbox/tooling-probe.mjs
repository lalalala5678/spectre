/**
 * tooling-probe — search provider 连通校验(设置面板保存 webSearch.apiKey 用)。
 * 与 tooling.mjs PROVIDERS 同实现的探针:同 key 同端点打一发最小查询,
 * 认证/权限错误显形为保存失败, 不落盘。
 */
const PROBES = {
  zhipu: async (cfg) => {
    const res = await fetch('https://open.bigmodel.cn/api/paas/v4/web_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ search_engine: 'search_std', count: 1, search_query: 'test' }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => null);
    if (data?.error) return { ok: false, error: `zhipu: ${data.error.message ?? data.error.code}` };
    if (!res.ok) return { ok: false, error: `zhipu HTTP ${res.status}` };
    return { ok: true };
  },
  brave: async (cfg) => {
    const res = await fetch('https://api.search.brave.com/res/v1/web/search?q=test&count=1', {
      headers: { Accept: 'application/json', 'X-Subscription-Token': cfg.apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `brave HTTP ${res.status}${res.status === 401 ? '(key 无效)' : ''}` };
    return { ok: true };
  },
  tavily: async (cfg) => {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: cfg.apiKey, query: 'test', max_results: 1 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `tavily HTTP ${res.status}${res.status === 401 ? '(key 无效)' : ''}` };
    return { ok: true };
  },
};

export async function probeSearchProvider(provider, cfg) {
  const fn = PROBES[provider];
  if (!fn) return { ok: true }; // searxng/未知: 免校验(baseUrl 运行时才打)
  try {
    return await fn(cfg);
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
  }
}
