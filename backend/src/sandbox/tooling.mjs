/**
 * Tooling-agent toolkit — the capabilities the `tools` agent uses to
 * DISCOVER, BUILD and CONFIGURE skills / MCP servers / CLI tools for
 * OTHER agents. Design axioms (AGENTS.md):
 *   · each config agent CONFIGURES mounts for named agents — it never
 *     holds the configured skill/MCP itself (mount isolation is by
 *     agentKey at session creation, unchanged);
 *   · CLI installs are environment-level (shared PATH, 公理二);
 *   · generic web search is an OPTIONAL pluggable provider (default
 *     none — zero vendor lock); the first-class discovery channels are
 *     keyless vertical APIs (MCP registry / GitHub / package managers).
 */
import { Type } from '@earendil-works/pi-ai';

import { saveSkill, deleteSkill, listSkillsTree } from './skills.mjs';
import { loadMcpConfig, testMcpServer } from './mcp.mjs';
import { listInstalledTools, sandboxConfig, uninstallCliTool, readInstallLog } from './container.mjs';
import { AGENT_KEYS, CONFIG_AGENT_KEYS } from '../agents.mjs';
import { getPrefs } from '../projects.mjs';
import { CONFIG } from '../config.mjs';
// CS1-R12: 信封单源 pi.mjs(errText 曾与 okText 逐字同——双胞胎漂移过)
import { sayText as okText, sayError as errText } from '../pi.mjs';
import { applyMcpAndMounts } from './apply-config.mjs';
import { providerFetch } from './provider-specs.mjs';
import { access } from 'node:fs/promises';
import { HOST, CONTAINER } from './exec-env.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ------------------------------------------------------------- helpers

// ------------------------------------------------- vertical discovery

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io';

/** Zero-key vertical channels, tried by query intent. */
const searchCache = new Map(); // registry 10min TTL(agent 终审: 反复超时→缓存命中)

async function searchVertical(query) {
  // R31: 四通道并行(此前串行, registry ~10-15s 拖累每次搜索总时延)
  const q = query.toLowerCase();
  // R31: registry 仅 MCP 发现类查询参战——通用查询该通道既慢(10-18s+)
  // 又零贡献, 超时行反复被席位扣分; 条件化后不相关查询不再出现该通道。
  const registryRelevant = /mcp|modelcontextprotocol|\bserver\b/i.test(query);
  const chRegistry = (async () => {
    if (!registryRelevant) return null;
    // 10 分钟 TTL 进程内缓存(同查询第二次起即时); 慢通道已并行不拖总时延。
    const cacheKey = `reg:${query}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 600_000) return cached.value;
    try {
      const res = await fetch(`${REGISTRY_BASE}/v0.1/servers?search=${encodeURIComponent(query)}`,
        { signal: AbortSignal.timeout(30000) });
      const data = res.ok ? await res.json() : null;
      const items = (data?.servers ?? []).slice(0, 5).map(({ server }) => ({
        title: server?.name ?? '?',
        url: server?.repository?.url
          ?? `https://registry.modelcontextprotocol.io/#servers/${encodeURIComponent(server?.name ?? '')}`,
        snippet: server?.description ?? '',
      }));
      const val = { channel: 'mcp-registry', items, query };
      searchCache.set(cacheKey, { ts: Date.now(), value: val });
      return val;
    } catch (e) {
      return { channel: 'mcp-registry', items: [], error: String(e?.message ?? e), query };
    }
  })();
  const ghSearch = async (qtext) => {
    const kind = /skill/.test(q) ? 'SKILL.md' : /mcp/.test(q) ? 'mcp package.json' : '';
    // R31 查询归一(agent A/B 实测: "WordPress plugin RCE poc 2025"=0,
    // 去掉年份=5 条高质量命中)——GitHub 搜索全词 AND, 年份几乎总是
    // 过度约束, 派发前剥离。
    const ghQuery = qtext.replace(/\b(19|20)\d{2}\b/g, '').replace(/\s+/g, ' ').trim();
    const ghq = (kind ? `${ghQuery} ${kind}` : ghQuery) + ' in:name,description';
    const res = await fetch(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(ghq)}`
      + `&sort=stars&order=desc&per_page=5`,
      { headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000) });
    const data = res.ok ? await res.json() : null;
    return (data?.items ?? []).map(r => ({
      title: r.full_name, url: r.html_url,
      snippet: (r.description ?? '') + ` ★${r.stargazers_count}`,
    }));
  };
  const chGithub = (async () => {
    try {
      let items = await ghSearch(query);
      // R31 放宽重试: 多词 AND 过约束漏召回(weakcred 实测漏掉
      // danielmiessler/SecLists)——0 命中时逐词收缩再试一次。
      if (!items.length) {
        const tokens = query.split(/\s+/).filter(w => w.length > 2);
        for (let drop = 1; drop < tokens.length && !items.length; drop++) {
          items = await ghSearch(tokens.slice(0, tokens.length - drop).join(' '));
        }
      }
      return { channel: 'github', items, query };
    } catch (e) {
      return { channel: 'github', items: [], error: String(e?.message ?? e), query };
    }
  })();
  const qTokens = () => new Set(String(query).toLowerCase().match(/[a-z\u4e00-\u9fff]{2,}/g) ?? []);
  const mkPkgChannel = (name, search) => (async () => {
    try {
      const items = await search();
      // R31: 包库通道零重叠过滤(实测 5/5 全噪声)——标题与查询词零
      // 重叠的包条目剔除。
      // 词元 ≥4 字符——3 字母短词(kit/log)曾放行 drizzle-kit 类噪声
      const toks = new Set([...qTokens()].filter(tk => tk.length >= 4));
      const filtered = toks.size === 0 ? items : items.filter(h => {
        const title = (h.title ?? '').toLowerCase();
        for (const tk of toks) if (title.includes(tk)) return true;
        return false;
      });
      return { channel: name, items: filtered, query };
    } catch (e) {
      return { channel: name, items: [], error: String(e?.message ?? e), query };
    }
  })();
  const chNpm = mkPkgChannel('npm', async () => {
    const res = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=5`,
      { signal: AbortSignal.timeout(8000) });
    const data = res.ok ? await res.json() : null;
    return (data?.objects ?? []).map(({ package: p }) => ({
      title: p.name, url: `https://www.npmjs.com/package/${p.name}`,
      snippet: (p.description ?? '').slice(0, 120),
    }));
  });
  // pip 通道已移除(2026-09-29: pypi.org/search 改 JS 渲染 SPA, HTML
  // 抓取上游死亡——零命中的假象不如不显示; pip 包经 github/npm 通道仍可发现)
  const all = await Promise.allSettled([chRegistry, chGithub, chNpm]);
  return all.map(r => r.status === 'fulfilled' ? r.value
    : { channel: '?', items: [], error: String(r.reason) }).filter(Boolean);
}

// -------------------------------------------------- generic providers

// CS1-R17: 请求形状(endpoint/headers/body)单源 provider-specs.mjs——
// 响应映射与错误语义留在此层(探针侧另有 ok/error 语义)。
const RESULT_SHAPES = {
  zhipu: data => (data?.search_result ?? []).map(r => ({
    title: r.title, url: r.link, snippet: r.content ?? '' })),
  brave: data => (data?.web?.results ?? []).map(r => ({
    title: r.title, url: r.url, snippet: r.description ?? '' })),
  tavily: data => (data?.results ?? []).map(r => ({
    title: r.title, url: r.url, snippet: r.content ?? '' })),
};
const PROVIDERS = {
  zhipu: async (q, cfg) => {
    const { res, data } = await providerFetch('zhipu', cfg, { query: q, count: 8 });
    // R30: 401/错误体此前被吞成"0 命中"(agent 四轮实测判读"挂名未通"
    // 完全正确)——错误必须 throw 走 catch 显形。
    if (data?.error) throw new Error(`zhipu: ${data.error.message ?? data.error.code ?? 'API 错误'}`);
    if (!res.ok) throw new Error(`zhipu HTTP ${res.status}`);
    return RESULT_SHAPES.zhipu(data);
  },
  brave: async (q, cfg) => {
    const { res, data } = await providerFetch('brave', cfg, { query: q, count: 8 });
    if (!res.ok || data?.error) throw new Error(`brave: ${data?.error?.message ?? `HTTP ${res.status}`}`);
    return RESULT_SHAPES.brave(data);
  },
  tavily: async (q, cfg) => {
    const { data } = await providerFetch('tavily', cfg, { query: q, count: 8 });
    return RESULT_SHAPES.tavily(data);
  },
  searxng: async (q, cfg) => {
    const { res, data } = await providerFetch('searxng', cfg, { query: q, count: 8 });
    if (!res.ok) throw new Error(`searxng HTTP ${res.status}`);
    return (data?.results ?? []).slice(0, 8).map(r => ({
      title: r.title, url: r.url, snippet: r.content ?? '' }));
  },
};

// ------------------------------------------------------- the tools

/**
 * Per-role toolkits — boundary axiom (AGENTS.md): each config agent
 * holds EXACTLY its own configuration tools plus its OWN search/fetch
 * instances (independent per agent — never a 4th role).
 */
export function buildToolingTools(record, caps) {
  const all = buildAllToolingTools(caps, record);
  switch (record.agentKey) {
    case 'skill-config':
      return [all.configureSkill, all.deleteSkillTool, all.listToolConfig,
        all.searchWeb, all.fetchUrl, all.wakeAgent];
    case 'mcp-config':
      return [all.configureMcp, all.removeMcpServer, all.listToolConfig,
        all.testMcp, all.searchWeb, all.fetchUrl, all.wakeAgent];
    case 'cli-config':
      return [all.listToolConfig, all.uninstallCli,
        all.searchWeb, all.fetchUrl, all.wakeAgent];
    case 'recon':
      // 资产测绘 agent 的独立网络查询实例(共享工具→各持独立实例公理):
      // search_web 重新面向 OSINT/dork 描述;fetch_url 复用同一构建。
      // 无配置智能体专属工具 — 那些永远不属于业务 agent。
      return [all.reconSearchWeb, all.fetchUrl];
    case 'nday':
      // NDay agent 独立实例: fetch_url(CVE 详情/POC readme/patch 页)+
      // search_web(CS5-N1: 此前缺席——铁律'各持独立实例'应含两者,
      // AGENTS.md'全部'行因此失真)。
      return [all.searchWeb, all.fetchUrl];
    default:
      // 其余业务智能体(api/exploit/weakcred/phish/c2/persistence/postex/
      // autopwn/report)各持独立 search_web+fetch_url 实例——AGENTS.md
      // 铁律"共享工具→各持独立实例";此前 default 空 数组使 7 个业务
      // agent 搜索链完全不可达(api agent 实测反馈"search_web 未注册")。
      return [all.searchWeb, all.fetchUrl];
  }
}

function buildAllToolingTools(caps, sessionRecord) {
  // R22-F4: 真实会话 record——wake_agent 需 requester 的 workSessionId
  // (此前 '_all' 占位符令目标会话恒落 _default 工作区+提示词身份
  // 失真, 且回执承诺的 read_session 复盘被 R12-F1 作用域判死)。
  const record = sessionRecord ?? { agentKey: '_all' };
  const configureSkill = {
    name: 'configure_skill',
    label: '配置技能',
    description:
      '[creates event] Write a SKILL.md and mount it to NAMED agents. '
      + 'Skill content uses agentskills.io format (name + one-line '
      + 'trigger description + full markdown guide). Only the named '
      + 'agents load it (mount isolation); takes effect for their NEW '
      + 'sessions via the on-demand index (full text is read by the '
      + 'agent when needed, never prompt-dumped).',
    executionMode: 'sequential',
    parameters: Type.Object({
      agentKeys: Type.Array(Type.String(), { minItems: 1,
        description: 'Target agent keys (e.g. ["recon","api"])' }),
      name: Type.String({ description: 'Skill name (kebab-case)' }),
      description: Type.String({ description: 'One-line trigger condition (shown in the index)' }),
      content: Type.String({ description: 'Full skill guide (markdown)' }),
    }),
    execute: async (_id, p) => {
      // Hard-fail on ALL-invalid targets (silent no-op success is the
      // most dangerous failure mode for a write op — review round 1).
      const bad = p.agentKeys.filter(k => !AGENT_KEYS.includes(k));
      if (bad.length === p.agentKeys.length) {
        return okText(`✗ 拒绝:目标智能体全部无效(${bad.join(',')})。`
          + `合法值:${AGENT_KEYS.join(',')}`);
      }
      const paths = [];
      for (const key of p.agentKeys.filter(k => AGENT_KEYS.includes(k))) {
        paths.push(await saveSkill(key, p));
      }
      await applyMcpAndMounts();
      const warn = bad.length
        ? `\n⚠️ 跳过无效智能体:${bad.join(',')}(合法值:${AGENT_KEYS.join(',')})` : '';
      return okText(`✓ 技能 ${p.name} 已挂载:\n`
        + paths.map(x => `- ${x}`).join('\n') + warn
        + '\n对目标智能体的新会话生效(按需加载:索引入提示,全文需要时自读)。');
    },
  };

  const configureMcp = {
    name: 'configure_mcp',
    label: '配置 MCP',
    description:
      '[creates event] Register an MCP server and mount it to NAMED '
      + 'agents. transport http = remote server (url+headers); stdio = '
      + 'command run on host or inside the sandbox (where). Use '
      + 'test_mcp_server first to verify connectivity.',
    executionMode: 'sequential',
    parameters: Type.Object({
      name: Type.String({ description: 'Server name' }),
      transport: Type.Union([Type.Literal('http'), Type.Literal('stdio')]),
      agents: Type.Array(Type.String(), { minItems: 1,
        description: 'Target agent keys' }),
      url: Type.Optional(Type.String({ description: 'http: server URL' })),
      headers: Type.Optional(Type.Record(Type.String(), Type.String(),
        { description: 'http: auth headers' })),
      command: Type.Optional(Type.Array(Type.String(),
        { description: 'stdio: argv to start the server' })),
      where: Type.Optional(Type.Union([Type.Literal('host'),
        Type.Literal('sandbox')])),
    }),
    execute: async (_id, p) => {
      // Runtime validation beats anyOf-schema complexity: same effect,
      // friendlier message (review round 1: conditional-required gap).
      if (p.transport === 'stdio' && !(p.command?.length)) {
        return okText('✗ 拒绝:stdio 传输必须提供 command(启动命令数组)。');
      }
      if (p.transport === 'http' && !p.url) {
        return okText('✗ 拒绝:http 传输必须提供 url。');
      }
      const bad = (p.agents ?? []).filter(k => !AGENT_KEYS.includes(k));
      if (bad.length === (p.agents ?? []).length || !(p.agents ?? []).length) {
        return okText(`✗ 拒绝:挂载目标全部无效(${bad.join(',') || '空'})。`
          + `合法值:${AGENT_KEYS.join(',')}`);
      }
      // Write-path precheck (one-shot, not the rejected per-list
      // health probing): a where=sandbox stdio server can never start
      // when the active driver is local — reject instead of storing a
      // permanently-dead mount (round-2 review).
      if (p.transport === 'stdio' && p.where === 'sandbox'
        && sandboxConfig().driver !== 'docker') {
        return okText('✗ 拒绝:where=sandbox 需要 docker driver(当前=local)。'
          + '请改 where=host,或先启用 docker 沙箱。');
      }
      // R22-F2: 锁内合一判存+写(两次独立 load 自带 TOCTOU)——组合
      // 语义(close 先行)由 applyMcpAndMounts 固化
      let existed = false;
      await applyMcpAndMounts({
        closeName: p.name, closeFirst: true,
        mutate: list => {
          existed = list.some(x => x.name === p.name);
          return [...list.filter(x => x.name !== p.name), p];
        },
      });
      const desc = p.transport === 'http'
        ? `url=${p.url}` : `command=[${p.command.join(' ')}] where=${p.where ?? 'host'}`;
      const warn = bad.length
        ? `\n⚠️ 跳过无效智能体:${bad.join(',')}` : '';
      return okText(`✓ ${existed ? '覆盖更新' : '新建'} MCP server ${p.name}:\n`
        + `- ${desc}\n- 挂载:[${p.agents.join(',')}]${warn}`
        + '\n对目标智能体的新会话生效;建议按名再 test_mcp_server 验证。');
    },
  };

  const listToolConfig = {
    name: 'list_tool_config',
    label: '查询工具配置',
    description:
      '[read-only] Current tooling landscape: per-agent skills, MCP '
      + 'servers with mounts + launch config, installed CLI commands '
      + 'AND the install-log ledger (what was installed by command — '
      + 'the same ledger uninstall_cli clears). Pass section to read '
      + 'one domain only.',
    executionMode: 'sequential',
    parameters: Type.Object({
      section: Type.Optional(Type.Union([
        Type.Literal('skills'), Type.Literal('mcp'), Type.Literal('cli')]),
        { description: 'Optional: only one domain (default: all three)' }),
    }),
    execute: async (_id, p) => {
      const want = p.section ?? 'all';
      const parts = [];
      if (want === 'all' || want === 'skills') {
        const skills = await listSkillsTree(AGENT_KEYS);
        parts.push(`技能挂载:\n${skills.map(s => `- ${s.agentKey}: ${s.name}`).join('\n') || '(无)'}`);
      }
      if (want === 'all' || want === 'mcp') {
        const mcps = (await loadMcpConfig())
          .map(s => `- ${s.name}(${s.transport}) → [${(s.agents ?? []).join(',')}] `
            + (s.transport === 'http' ? `url=${s.url ?? '?'}`
              : `cmd=${(s.command ?? []).join(' ')} where=${s.where ?? 'host'}`));
        parts.push(`MCP 服务器:\n${mcps.join('\n') || '(无)'}`);
      }
      if (want === 'all' || want === 'cli') {
        const cli = await listInstalledTools();
        const ledger = await readInstallLog();
        parts.push(`沙箱已装命令(${cli.length} 个,节选):\n${cli.slice(0, 60).join(' ') || '(基础镜像)'}`
          + (cli.length > 60 ? `\n…另 ${cli.length - 60} 个(可用 which <命令> 或 ls /opt/tools/npm-global/lib/node_modules 探测)` : ''));
        parts.push(`install-log 安装账本(${ledger.length} 条):\n`
          + (ledger.slice(-15).map(c => `- ${c}`).join('\n') || '(无记录——bash 手装不经账本)'));
      }
      return okText(parts.join('\n\n'));
    },
  };

  const testMcp = {
    name: 'test_mcp_server',
    label: '测试 MCP',
    description:
      '[read-only] Connectivity + tool-list test for a REGISTERED MCP '
      + 'server (or an ad-hoc config passed inline, for pre-registration '
      + 'verification of a freshly built/downloaded server).',
    executionMode: 'sequential',
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: 'Registered server name' })),
      transport: Type.Optional(Type.Union([Type.Literal('http'), Type.Literal('stdio')])),
      url: Type.Optional(Type.String()),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      command: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (_id, p) => {
      const registered = await loadMcpConfig();
      if (p.name && !registered.some(s => s.name === p.name)) {
        return okText(`✗ 未注册的 server:${p.name}。当前已注册:`
          + (registered.map(s => s.name).join(', ') || '(无)')
          + ';内联测试请改传 transport+command/url 参数。');
      }
      if (!p.name && !p.url && p.transport !== 'stdio' && !p.command) {
        return okText('✗ 内联测试缺少目标:请传 url+transport=http,或 command+transport=stdio。');
      }
      // R22-F5: {transport:'stdio'} 无/空 command 穿透原守卫第三支
      // → StdioRpc undefined argv → 回执是原始 TypeError 非引导性拒绝。
      if (!p.name && p.transport === 'stdio' && !(p.command?.length)) {
        return okText('✗ 拒绝:stdio 内联测试必须提供 command(非空字符串数组)。');
      }
      let server = p.name
        ? registered.find(s => s.name === p.name) : null;
      if (!server && !p.name) server = {
        name: p.name ?? 'ad-hoc', transport: p.transport ?? (p.url ? 'http' : 'stdio'),
        url: p.url, headers: p.headers, command: p.command,
        // follow the ACTIVE driver: sandbox only exists for docker
        where: sandboxConfig().driver === 'docker' ? 'sandbox' : 'host',
      };
      const t0 = Date.now();
      const r = await testMcpServer(server);
      if (!r.ok) return okText(`✗ 连接失败:${r.error}`);
      return okText(`✓ ${r.serverName} 连通(${Date.now() - t0}ms,协议 ${r.protocol ?? '?'}),`
        + `工具 ${r.tools.length} 个:${r.tools.join(', ') || '(空)'}`);
    },
  };

  // Shared search core — used by BOTH the config-agent instance (tool-
  // candidate oriented) and recon's OSINT instance (same axiom as the
  // config trio: a capability needed by multiple agents = one instance
  // each, never a shared singleton).

function shellScopeTargets() {
  // 同源 agent-runtime shellScope(scope.json; 逐次读——授权窗口实时开闭)
  try { return JSON.parse(readFileSync(join(CONFIG.dataDir, 'tools/c2/scope.json'), 'utf8'))?.targets ?? []; }
  catch { return []; }
}

  const runSearch = async (_id, p) => {
    const receipt = ['渠道分解:'];
    const hits = [];
    let othersHaveHits = false;
    // 意图路由(agent 实测反馈): 漏洞/PoC 意图的查询打 npm/pip 包库
    // 只有单 token 噪声命中(查"Spectre WordPress RCE"返回 WP 组件包,
    // 情报价值为零)——此类意图跳过包管理通道。
    const vulnIntent = /CVE-\d|\bRCE\b|\bSQLi\b|\bXSS\b|\b0day\b|\bnday\b|poc|exploit|漏洞|利用/i.test(p.query);
    const channels = await searchVertical(p.query);
    // CS41-B8: pip 通道已移除(见上注)——死值出过滤; 漏洞意图仅跳 npm。
    const usable = vulnIntent
      ? channels.filter(ch => ch.channel !== 'npm')
      : channels;
    if (vulnIntent) receipt.push('- 意图路由:漏洞/PoC 查询已跳过 npm 包库通道');
    for (const ch of usable) {
      if (ch.error) {
        receipt.push(`- ${ch.channel}:0 命中(通道错误:${ch.error})`);
      } else if (ch.items.length) {
        receipt.push(`- ${ch.channel}:${ch.items.length} 命中`);
        hits.push(...ch.items.map(it => ({ ...it, channel: ch.channel })));
        othersHaveHits = true;
      } else {
        receipt.push(`- ${ch.channel}:0 命中${othersHaveHits ? '(该通道可能异常或无此类目)' : ''}`);
      }
      receipt[receipt.length - 1] += ` [下发: ${String(ch.query ?? p.query).slice(0, 80)}]`;
    }
    // loop36-QA: 越界提示(信息性, 不拦)——query 含 IPv4 且不在授权
    // 清单时附注(搜索/OSINT 不受限; 对该目标主动探测前需授权)。
    let scopeNote = '';
    try {
      const ips = String(p.query).match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];
      const targets = shellScopeTargets();
      const out = [...new Set(ips.filter(x => !targets.includes(x)))];
      if (out.length) scopeNote = `\n[越界提示] query 含 ${out.join(', ')} 不在渗透授权清单——OSINT/检索不受限, 但对其主动探测/扫描前需 request_authorization。`;
    } catch { /* scope 读失败静默(提示为增强非门禁) */ }
    const cfg = await getPrefs();
    // U2: 唯一来源=设置面板 common.webSearch(旧顶层 webSearchProvider
    // 从未被任何部署设置过,零迁移直接切换)
    const ws = cfg.commonSettings?.webSearch ?? {};
    const provider = ws.provider ?? 'none';
    if (provider !== 'none') {
      try {
        const generic = await PROVIDERS[provider](p.query, ws);
        // R31 相关性过滤(api agent 实测: 33 命中混四成噪声)——查询词元
        // 与标题/摘要零重叠的条目剔除, 回执保留剔除计数。
        const qTokens = new Set(String(p.query).toLowerCase().match(/[a-z\u4e00-\u9fff]{2,}/g) ?? []);
        const relevant = generic.filter(h => {
          const hay = `${h.title ?? ''} ${h.snippet ?? ''}`.toLowerCase();
          for (const tk of qTokens) if (hay.includes(tk)) return true;
          return qTokens.size === 0;
        });
        const dropped = generic.length - relevant.length;
        receipt.push(`- 通用web(${provider}):${relevant.length} 命中`
          + `(过滤 ${dropped} 条零相关噪声) [下发: ${String(p.query).slice(0, 80)}]`);
        hits.push(...relevant.map(it => ({ ...it, channel: `web:${provider}` })));
      } catch (e) {
        receipt.push(`- 通用web(${provider}):错误 ${String(e?.message ?? e)}`);
      }
    } else {
      receipt.push('- 通用web:未配置 provider(当前=none,仅以上垂直结果;不假装搜过)');
    }
    if (!hits.length) {
      return okText(receipt.join('\n') + '\n\n无结果。建议换关键词或明确目标渠道。' + scopeNote);
    }
    // cross-channel dedupe (same url/title) — registry pagination
    // once listed the same server 3x in a row (round-3 review)
    // dedupe: exact url/title, AND cross-channel same-name merges
    // (registry + github often carry the same project — round-3
    // review polish; sources are unioned so nothing is lost)
    // 归一链(cli-config 五验: #11/#16 同页不同锚点存活——锚点/协议/
    // www/双重编码/utm/尾斜杠全链归一, 同页变体必撞键)
    const normUrl = u => String(u ?? '')
      .replace(/#[^#]*$/, '')                          // 片段锚点
      .replace(/%25([0-9a-f]{2})/gi, '%$1')            // 双重编码还原
      .replace(/[?&]utm_[a-z]+=[^&]*/gi, '').replace(/[?]$/, '')
      .replace(/^http:\/\//i, 'https://')
      .replace(/^(https:\/\/)www\./i, '$1')
      .replace(/\/$/, '');
    const byName = new Map();
    for (const h of hits) {
      const urlKey = normUrl(h.url) || h.title;
      if ([...byName.values()].some(e => e.urls.has(urlKey))) continue;
      const k = h.title.split('/').pop().toLowerCase();
      const e = byName.get(k);
      if (e && e.title === h.title) {
        e.urls.add(urlKey); e.count += 1;
      } else if (!e) {
        byName.set(k, { ...h, urls: new Set([urlKey]), count: 1 });
      } else {
        byName.set(`${k}#${h.title}`, { ...h, urls: new Set([urlKey]), count: 1 });
      }
    }
    let uniq = [...byName.values()].map(e => ({
      ...e,
      url: [...e.urls].filter(Boolean).join(' | '),
    }));
    // R31 镜像合并(cli-config 七验: npmjs.org/.com/npmjs.cn/typeerror.org
    // 同一逻辑页四卡并存)——同标题+同末段 slug 跨主机=强同页信号, 合并
    // 计数并保留最高优先层; 单纯 URL 归一无法跨主机。
    const slugOf = u => { const m = String(u ?? '').match(/([a-z0-9-]+)\/??(?:[?#].*)?$/i); return (m?.[1] ?? '').toLowerCase(); };
    // 标题归一(cli-config 十验定稿): ①先剥双空格站点后缀("globally␣␣npm
    // Docs" 无分隔符变体——先折叠空白会抹掉边界, 九轮幸存根因) ②再剥
    // 分隔符后缀(—/|/·/-) ③最后折叠+小写
    const titleNorm = s => String(s ?? '')
      .replace(/\s{2,}[A-Za-z0-9. ]{2,32}\s*$/, '')
      .replace(/\s*[|—–·-]\s*[^|—–·-]{1,32}$/u, '')
      .toLowerCase().replace(/\s+/g, ' ').trim();
    const mirrorMap = new Map();
    const mirrorExamples = [];
    for (const h of uniq) {
      const tn = titleNorm(h.title);
      // 键策略: 归一标题 ≥20 字符时标题为主(npmjs.cn 镜像 slug 与正主
      // 不同, 八验实锤); 短标题才叠加 slug 防过合并
      const key = tn.length >= 20 ? `t:${tn}`
        : `ts:${tn}|${slugOf((h.urls ? [...h.urls][0] : h.url) || '')}`;
      if (key === 't:' || key === 'ts:|') continue;
      const e = mirrorMap.get(key);
      if (e && normUrl([...e.urls][0] ?? e.url) !== normUrl([...h.urls][0] ?? h.url)) {
        e.mirrorCount = (e.mirrorCount ?? 1) + 1;
        mirrorExamples.push(`${String(h.url).slice(0, 60)} → 并入「${String(e.title).slice(0, 40)}」`);
      } else if (!e) {
        mirrorMap.set(key, h);
      }
    }
    const mirrorMerged = uniq.length - mirrorMap.size;
    uniq = [...mirrorMap.values()];
    // 候选分页(start 偏移; phish 席位实测"37 条仅示 12 无分页"扣分)
    // 相关性排序: 标题命中的查询词元数降序(cli-config 席位实测"首位
    // 结果相关性存疑"——字面命中包排首)。
    const rankToks = [...new Set(String(p.query).toLowerCase().match(/[a-z\u4e00-\u9fff]{3,}/g) ?? [])];
    const score = h => {
      const title = (h.title ?? '').toLowerCase();
      return rankToks.reduce((s, tk) => s + (title.includes(tk) ? 1 : 0), 0);
    };
    const tier = h => (String(h.channel ?? '').startsWith('web:') ? 1 : 0);  // 垂直=0 优先(兑现描述承诺)
    uniq.sort((a, b) => tier(a) - tier(b) || score(b) - score(a));
    // R31: 分页稳定性——uniq 结果集按查询缓存 10 分钟(cli-config 四验:
    // 此前每次调用重跑全管线, zhipu 实时漂移使跨页重叠/跳号, 回执承诺
    // 的"传 start 取下一段"名不副实)。
    const resKey = `res:${p.query}`;
    let uniqList = null;
    const cachedRes = searchCache.get(resKey);
    if (cachedRes && Date.now() - cachedRes.ts < 600_000) {
      uniqList = cachedRes.value;
    } else {
      uniqList = uniq;
      searchCache.set(resKey, { ts: Date.now(), value: uniq });
    }
    const pStart = Math.max(0, Number(p.start) || 0);
    const shown = uniqList.slice(pStart, pStart + 12);
    // loop36-QA③: start 越界不再渲染负区间(13-12)——空页给显式诊断
    // 与回退指引(空结果必须有诊断信息, AGENTS 原则4)。
    if (!shown.length && pStart > 0) {
      return okText(receipt.join('\n') + scopeNote
        + `\n\n候选 0 条(start=${pStart} 越界: 结果集共 ${uniqList.length} 条)。`
        + (uniqList.length ? `\n有效区间 0-${Math.max(0, uniqList.length - 1)}(传 start=${Math.max(0, uniqList.length - 12)} 取末页; 结果集 10 分钟内缓存稳定)` : '\n(结果集本身为空——换关键词或明确目标渠道)'));
    }
    const moreHint = uniqList.length > pStart + 12
      ? `(传 start=${pStart + 12} 取下一段; 结果集 10 分钟内缓存稳定)` : '';
    const dedupeNote = mirrorMerged > 0
      ? `\n镜像合并: ${mirrorMerged} 条 — ${mirrorExamples.slice(0, 3).join('; ')}`
        + (mirrorMerged > 3 ? ` 等` : '') : '';
    return okText(receipt.join('\n') + scopeNote + dedupeNote
      + `\n\n候选(去重后 ${uniqList.length} 条,显示 ${pStart + 1}-${pStart + shown.length}${moreHint ? ' ' + moreHint : ''}):\n`
      + shown.map((h, i) =>
        `${pStart + i + 1}. [${h.channel ?? '?'}] ${h.title}${h.mirrorCount > 1 ? `(镜像 ×${h.mirrorCount})` : ''}\n   ${h.url}\n   ${(h.snippet ?? '').slice(0, 120)}`)
        .join('\n'));
  };

  const searchWeb = {
    name: 'search_web',
    label: '搜索',
    description:
      '[read-only] Tool candidate search. Vertical channels first (MCP '
      + 'official registry, GitHub API, npm in sandbox — all '
      + 'keyless); generic web search as fallback ONLY when a provider '
      + 'is configured. The receipt says which channels answered.',
    executionMode: 'sequential',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
      start: Type.Optional(Type.Number({ description: '候选分页偏移(每页 12)' })),
    }),
    execute: runSearch,
  };

  // 资产测绘 agent 的独立实例:同一执行核心,OSINT/dork 面向的描述。
  const reconSearchWeb = {
    name: 'search_web',
    label: 'OSINT 搜索',
    description:
      '[read-only] OSINT/web 搜索。query 里直接写完整搜索语法(如 '
      + 'site:target.edu.cn、filetype:xlsx 学号、"公司名" 备案)。通用 '
      + 'web provider 未配置时回执会如实说明,此时改用 fetch_url 定向'
      + '抓取(如 Bing 结果页)或 bash curl;绝不假装搜过。',
    executionMode: 'sequential',
    parameters: Type.Object({
      query: Type.String({ description: '搜索式(可含 dork 语法)' }),
    }),
    execute: runSearch,
  };

  const fetchUrl = {
    name: 'fetch_url',
    label: '抓取网页',
    description:
      '[read-only] Fetch a URL and return readable text (markdown-ish). '
      + 'GitHub blob URLs are auto-rewritten to raw for clean markdown. '
      + 'Use for READMEs, docs and registry pages.',
    executionMode: 'sequential',
    parameters: Type.Object({
      url: Type.String({ description: 'http(s) URL' }),
      seq: Type.Optional(Type.Number({ description: '分页偏移(字符), 截断时回执标注"传 seq=N 取下一段"' })),
    }),
    execute: async (_id, p) => {
      let url = p.url;
      const gh = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url);
      if (gh) url = `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}`;
      const limit = 8000;
      const offset = Math.max(0, Number(p.seq) || 0);
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'spectre-tooling' },
          signal: AbortSignal.timeout(15000) });
        const ctype = res.headers.get('content-type') ?? '';
        const text = await res.text();
        const body = ctype.includes('html') ? htmlToText(text) : text;
        const page = body.slice(offset, offset + limit);
        const more = body.length > offset + limit
          ? `\n\n(正文 ${page.length}/${body.length - offset} 字符, 传 seq=${offset + limit} 取下一段)`
          : (offset > 0 ? `\n\n(本段至正文末尾, 共 ${body.length} 字符)` : '');
        return okText(`${url}\n\n${page}${more}`);
      } catch (e) {
        // r33-D6: 负路径回执对齐 read 标杆——原因分类+补救指引
        // (此前仅 "fetch failed", DNS/超时/TLS/4xx 不可辨)。
        // r33-D6b: undici 真实错误在 e.cause(message 恒 'fetch failed'),
        // 四类探针曾逐字同型——msg 优先取 cause.code/message。
        const c = e?.cause;
        const msg = String(c?.code ?? c?.message ?? e?.message ?? e ?? '');
        const why = /ENOTFOUND|getaddrinfo/i.test(msg) ? '域名解析失败(host 不存在或本环境无外联 DNS)'
          : /ETIMEDOUT|timeout/i.test(msg) ? '连接超时(目标无响应或被墙)'
          : /certificate|SSL|TLS|wrong version number/i.test(msg) ? 'TLS 握手失败(协议不匹配——https 打了明文口, 或证书问题)'
          : /ECONNREFUSED/i.test(msg) ? '连接被拒(端口未开)'
          : msg || '未知网络错误';
        return errText(`抓取失败:${why}。URL: ${String(url).slice(0, 120)}。可尝试: 换 http/https、去尾斜杠、确认目标在线; 需要搜索改用 search_web。`);
      }
    },
  };

  const deleteSkillTool = {
    name: 'delete_skill',
    label: '卸载技能',
    description:
      '[destructive] Unmount a skill from ONE named agent (removes its '
      + 'skill directory). Takes effect for that agent\'s NEW sessions. '
      + 'Only run on explicit user instruction; restate the target '
      + '(agent + skill name) before deleting.',
    executionMode: 'sequential',
    parameters: Type.Object({
      agentKey: Type.String({ description: 'Agent key (e.g. "recon")' }),
      name: Type.String({ description: 'Skill name to remove' }),
    }),
    execute: async (_id, p) => {
      if (!AGENT_KEYS.includes(p.agentKey)) {
        return okText(`✗ 未知智能体 ${p.agentKey};合法值:${AGENT_KEYS.join(',')}`);
      }
      // Existence check: "deleted" vs "never existed" must differ — a
      // typo'd skill name otherwise vanishes silently (review round 1).
      const dir = HOST.skills; // probe on the HOST fs
      try {
        await access(`${dir}/${p.agentKey}/${p.name}`);
      } catch {
        return okText(`✗ 技能不存在:${p.agentKey}/${p.name}(先 list_tool_config 核对名称拼写)。`);
      }
      await deleteSkill(p.agentKey, p.name);
      await applyMcpAndMounts();  // CS2-#2: 此前直接调 rebuildMounts 未导入(ReferenceError)
      // Receipt path keeps the CONTAINER vocabulary (agents think in
      // container paths — same convention configure_skill returns).
      return okText(`✓ 已删除 ${CONTAINER.skills}/${p.agentKey}/${p.name}`
        + `(对 ${p.agentKey} 的新会话生效)。`);
    },
  };

  const removeMcpServer = {
    name: 'remove_mcp_server',
    label: '注销 MCP',
    description:
      '[destructive] Unregister an MCP server (all mounts). Takes '
      + 'effect for NEW sessions. Only run on explicit user '
      + 'instruction; restate the server name before deleting.',
    executionMode: 'sequential',
    parameters: Type.Object({
      name: Type.String({ description: 'Server name to remove' }),
    }),
    execute: async (_id, p) => {
      const cfg = await loadMcpConfig();
      if (!cfg.some(s => s.name === p.name)) {
        return okText(`✗ 未注册的 server:${p.name}。当前已注册:`
          + (cfg.map(s => s.name).join(', ') || '(无)'));
      }
      // R22-F2(互斥删写)+连接失效语义收敛在 applyMcpAndMounts(CS2-#2:
      // 此前三函数直接调用均未导入, 注销工具面全链 ReferenceError)
      await applyMcpAndMounts({
        closeName: p.name,
        mutate: list => list.filter(s => s.name !== p.name),
      });
      return okText(`✓ 已注销 MCP server ${p.name}(对新会话生效,后台连接已关闭)。`);
    },
  };

  const uninstallCli = {
    name: 'uninstall_cli',
    label: '卸载 CLI',
    description:
      '[destructive] Uninstall a CLI from the shared layer (/opt/tools): '
      + 'probes binary, pip --target and npm --prefix layouts, removes '
      + 'files AND matching install-log entries (a rebuild would '
      + 'otherwise resurrect it). Only run on explicit user instruction.',
    executionMode: 'sequential',
    parameters: Type.Object({
      name: Type.String({ description: 'Package or command name' }),
    }),
    execute: async (_id, p) => {
      const r = await uninstallCliTool(p.name);
      if (!r.removed.length && !r.clearedLog.length) {
        return okText(`未找到 ${p.name} 的安装痕迹;可用 bash 探测实际安装路径后重试。`);
      }
      const logLines = (r.clearedLog.length
        ? `\n- install-log 清除 ${r.clearedLog.length} 条:` : '\n- install-log 无该包记录')
        + ((r.rewritten ?? []).length
          ? `\n- 账本行已改写(保留兄弟包重放记录,${r.rewritten.length} 条):\n  `
            + r.rewritten.map(w => `  ${w.slice(0, 120)}`).join('\n  ') : '');
      const aptLines = (r.aptRemoved ?? []).length
        ? '\n- apt 层:' + r.aptRemoved.map(c =>
            c.startsWith('FAILED')
              ? `\n  ⚠️ ${c}(包可能残留,请 bash dpkg -l 复核并手动处理)`
              : `\n  - ${c}`).join('')
        : '';
      return okText(`✓ 已卸载 ${p.name}:\n`
        + r.removed.map(x => `- 已删 ${x}`).join('\n')
        + aptLines
        + logLines
        + (r.clearedLog.length ? '\n  ' + r.clearedLog.map(c => `- ${c}`).join('\n  ') : ''));
    },
  };

  const wakeAgent = {
    name: 'wake_agent',
    label: '唤醒验证',
    description:
      '[spawns turn; synchronous — may take a minute] '
      + 'Wake ONE business agent and ask it to '
      + 'confirm its tooling state (a just-mounted skill/MCP, or a '
      + 'shared CLI command). It answers from its OWN toolface — the '
      + 'authoritative confirmation that a mount actually landed. Use '
      + 'for the mandatory verify step after configure/delete/remove '
      + '(pick any one of the mounted agents; for CLI installs pick any '
      + 'business agent).',
    executionMode: 'sequential',
    parameters: Type.Object({
      agentKey: Type.String({ description: 'Business agent key to wake (e.g. "recon")' }),
      question: Type.String({ description: 'The verification question, e.g. "你的索引里有 X 吗?调用它验证并贴回执"' }),
    }),
    execute: async (_id, p) => {
      if (!AGENT_KEYS.includes(p.agentKey) || CONFIG_AGENT_KEYS.includes(p.agentKey)) {
        return okText(`✗ 目标必须是业务智能体(${p.agentKey} 无效);`
          + `业务智能体:${AGENT_KEYS.filter(k => !CONFIG_AGENT_KEYS.includes(k)).join(',')}`);
      }
      if (!caps.wakeAgent) {
        return okText('✗ 唤醒服务不可用(capability 缺失)。');
      }
      const r = await caps.wakeAgent(record, p.agentKey, p.question);
      return okText(r.text);
    },
  };

  return { configureSkill, configureMcp, listToolConfig, testMcp,
    searchWeb, fetchUrl, deleteSkillTool, removeMcpServer, uninstallCli,
    wakeAgent, reconSearchWeb };
}

/** Minimal rule-based HTML→text (zero deps; strips nav/script/style,
 *  keeps headings/lists/links roughly). */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_, l, t) => `\n${'#'.repeat(Number(l))} ${t.replace(/<[^>]+>/g, '')}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi,
      (_, t) => `- ${t.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_, href, t) => `${t.replace(/<[^>]+>/g, '')} (${href})`)
    .replace(/<(p|div|br|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    // 兜底: 属性携带体(如 <h4 align="right">)在 h 规则外残留时二次清
    .replace(/<h\d[^>]*>/gi, '').replace(/<\/h\d>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
