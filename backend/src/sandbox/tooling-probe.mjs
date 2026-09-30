/**
 * tooling-probe — search provider 连通校验(设置面板保存 webSearch.apiKey 用)。
 * 与 tooling.mjs PROVIDERS 同实现的探针:同 key 同端点打一发最小查询,
 * 认证/权限错误显形为保存失败, 不落盘。
 */
// CS1-R17: 请求形状单源 provider-specs.mjs; 探针语义 = count=1 最小查询,
// 认证/权限错误显形为 {ok:false}。
const PROBES = {
  zhipu: async (cfg) => {
    const { res, data } = await providerFetch('zhipu', cfg, { query: 'test', count: 1 });
    if (data?.error) return { ok: false, error: `zhipu: ${data.error.message ?? data.error.code}` };
    if (!res.ok) return { ok: false, error: `zhipu HTTP ${res.status}` };
    return { ok: true };
  },
  brave: async (cfg) => {
    const { res } = await providerFetch('brave', cfg, { query: 'test', count: 1 });
    if (!res.ok) return { ok: false, error: `brave HTTP ${res.status}${res.status === 401 ? '(key 无效)' : ''}` };
    return { ok: true };
  },
  tavily: async (cfg) => {
    const { res } = await providerFetch('tavily', cfg, { query: 'test', count: 1 });
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
