/**
 * PROVIDER_SPECS (CS1-R17): search provider 的请求形状单源——endpoint/
 * method/headers/body 构造在此一处定义, tooling.mjs(正式搜索)与
 * tooling-probe.mjs(连通探针)派生各自的响应语义。此前两文件各持一份
 * 同实现(注释互认"同实现"), REPORT_NUDGE_TEXT 已示范这类双胞胎必漂。
 */

export const PROVIDER_SPECS = {
  zhipu: {
    method: 'POST',
    url: () => 'https://open.bigmodel.cn/api/paas/v4/web_search',
    headers: cfg => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    }),
    body: (q, count) => JSON.stringify({
      search_engine: 'search_std', count, search_query: q,
    }),
  },
  brave: {
    method: 'GET',
    url: (q, count) =>
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}`,
    headers: cfg => ({
      Accept: 'application/json',
      'X-Subscription-Token': cfg.apiKey,
    }),
    body: () => undefined,
  },
  tavily: {
    method: 'POST',
    url: () => 'https://api.tavily.com/search',
    headers: () => ({ 'Content-Type': 'application/json' }),
    body: (q, count, cfg) => JSON.stringify({
      api_key: cfg.apiKey, query: q, max_results: count,
    }),
  },
  searxng: {
    method: 'GET',
    url: null,  // baseUrl 来自 cfg, 在 providerFetch 里拼(实例自建)
    headers: () => ({}),
    body: () => undefined,
  },
};

/** Fetch one provider per its spec. searxng 的 url 需 cfg.baseUrl, 单独拼。 */
export async function providerFetch(provider, cfg, { query, count }) {
  const spec = PROVIDER_SPECS[provider];
  if (!spec) throw new Error(`unknown provider: ${provider}`);
  const url = provider === 'searxng'
    ? `${cfg.baseUrl}/search?q=${encodeURIComponent(query)}&format=json`
    : spec.url(query, count, cfg);
  const res = await fetch(url, {
    method: spec.method,
    headers: spec.headers(cfg),
    body: spec.body(query, count, cfg),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => null);
  return { res, data };
}
