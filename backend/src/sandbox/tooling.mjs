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
import { saveMcpConfig, loadMcpConfig, testMcpServer, closeMcpConnection } from './mcp.mjs';
import { listInstalledTools, sandboxConfig, uninstallCliTool, readInstallLog } from './container.mjs';
import { AGENT_KEYS } from '../agents.mjs';
import { makeExecutionEnv, ensureWorkspaceSync } from './exec-env.mjs';
import { getPrefs } from '../projects.mjs';

// ------------------------------------------------------------- helpers

async function rebuildMounts() {
  const { rebuildMounts: rb } = await import('./mount.mjs');
  await rb(AGENT_KEYS);
}

const okText = t => ({ content: [{ type: 'text', text: t }] });
const errText = t => ({ content: [{ type: 'text', text: t }] });

// ------------------------------------------------- vertical discovery

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io';

/** The exactly-three config agents (mirror of tools.mjs). */
const CONFIG_AGENT_KEYS = ['skill-config', 'mcp-config', 'cli-config'];

/** Zero-key vertical channels, tried by query intent. */
async function searchVertical(query) {
  const channels = [];
  const q = query.toLowerCase();
  // 1) MCP official registry (keyless)
  try {
    const res = await fetch(`${REGISTRY_BASE}/v0.1/servers?search=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(8000) });
    const data = res.ok ? await res.json() : null;
    // /v0.1/servers shape: { servers: [{ server: { name, description,
    //  repository: { url } } }] } (verified against the live openapi)
    const items = (data?.servers ?? []).slice(0, 5).map(({ server }) => ({
      title: server?.name ?? '?',
      url: server?.repository?.url
        ?? `https://registry.modelcontextprotocol.io/#servers/${encodeURIComponent(server?.name ?? '')}`,
      snippet: server?.description ?? '',
    }));
    channels.push({ channel: 'mcp-registry', items });
  } catch (e) {
    channels.push({ channel: 'mcp-registry', items: [], error: String(e?.message ?? e) });
  }
  // 2) GitHub search (keyless) — star-sorted so the real project
  //    outranks ★0 copycats (review round 1)
  try {
    const kind = /skill/.test(q) ? 'SKILL.md' : /mcp/.test(q) ? 'mcp package.json' : '';
    const ghq = (kind ? `${query} ${kind}` : query) + ' in:name,description';
    const res = await fetch(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(ghq)}`
      + `&sort=stars&order=desc&per_page=5`,
      { headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000) });
    const data = res.ok ? await res.json() : null;
    const items = (data?.items ?? []).map(r => ({
      title: r.full_name, url: r.html_url,
      snippet: (r.description ?? '') + ` ★${r.stargazers_count}`,
    }));
    channels.push({ channel: 'github', items });
  } catch (e) {
    channels.push({ channel: 'github', items: [], error: String(e?.message ?? e) });
  }
  // 3) npm registry (keyless, precise — the canonical package usually
  //    lives here, not in github copies)
  try {
    const res = await fetch(
      `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=5`,
      { signal: AbortSignal.timeout(8000) });
    const data = res.ok ? await res.json() : null;
    const items = (data?.objects ?? []).map(o => ({
      title: `npm:${o.package.name}`,
      url: `https://www.npmjs.com/package/${o.package.name}`,
      snippet: `${o.package.description ?? ''} v${o.package.version}`,
    }));
    channels.push({ channel: 'npm', items });
  } catch (e) {
    channels.push({ channel: 'npm', items: [], error: String(e?.message ?? e) });
  }
  return channels;
}

/** Package-manager search inside the sandbox (npm/pip/apt — keyless). */
async function searchPackages(query) {
  const env = makeExecutionEnv({ driver: 'local' }, '_tooling');
  const results = [];
  for (const cmd of [
    `npm search --json ${JSON.stringify(query)} 2>/dev/null | head -c 3000`,
    `pip3 index versions ${JSON.stringify(query)} 2>&1 | head -2`,
  ]) {
    const r = await env.exec(cmd, {}).catch(() => null);
    if (r?.ok) results.push(String(cmd.split(' ')[0]) + ':\n' + (r.value ? '' : ''));
  }
  return results;
}

// -------------------------------------------------- generic providers

const PROVIDERS = {
  zhipu: async (q, cfg) => {
    const res = await fetch(
      'https://open.bigmodel.cn/api/paas/v4/web_search',
      { method: 'POST',
        headers: { 'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ search_engine: 'search_std', count: 8,
          search_query: q }),
        signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    return (data?.search_result ?? []).map(r => ({
      title: r.title, url: r.link, snippet: r.content ?? '' }));
  },
  brave: async (q, cfg) => {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=8`,
      { headers: { Accept: 'application/json',
        'X-Subscription-Token': cfg.apiKey },
        signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    return (data?.web?.results ?? []).map(r => ({
      title: r.title, url: r.url, snippet: r.description ?? '' }));
  },
  tavily: async (q, cfg) => {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: cfg.apiKey, query: q, max_results: 8 }),
      signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    return (data?.results ?? []).map(r => ({
      title: r.title, url: r.url, snippet: r.content ?? '' }));
  },
  searxng: async (q, cfg) => {
    const res = await fetch(
      `${cfg.baseUrl}/search?q=${encodeURIComponent(q)}&format=json`,
      { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
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
  const all = buildAllToolingTools(caps);
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
      // NDay agent 的独立 fetch_url 实例(CVE 详情/POC readme/patch 页抓取)。
      return [all.fetchUrl];
    default:
      return [];
  }
}

function buildAllToolingTools(caps) {
  const record = { agentKey: '_all' }; // builders only use caps
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
      await rebuildMounts();
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
      const existed = (await loadMcpConfig()).some(x => x.name === p.name);
      closeMcpConnection(p.name); // re-config: drop the stale connection
      const list = (await loadMcpConfig()).filter(s => s.name !== p.name);
      await saveMcpConfig([...list, p]);
      await rebuildMounts();
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
  const runSearch = async (_id, p) => {
    const receipt = ['渠道分解:'];
    const hits = [];
    let othersHaveHits = false;
    for (const ch of await searchVertical(p.query)) {
      if (ch.error) {
        receipt.push(`- ${ch.channel}:0 命中(通道错误:${ch.error})`);
      } else if (ch.items.length) {
        receipt.push(`- ${ch.channel}:${ch.items.length} 命中`);
        hits.push(...ch.items);
        othersHaveHits = true;
      } else {
        receipt.push(`- ${ch.channel}:0 命中${othersHaveHits ? '(该通道可能异常或无此类目)' : ''}`);
      }
    }
    const cfg = await getPrefs();
    const provider = cfg.webSearchProvider ?? 'none';
    if (provider !== 'none') {
      try {
        const generic = await PROVIDERS[provider](p.query, cfg.webSearch ?? cfg);
        receipt.push(`- 通用web(${provider}):${generic.length} 命中`);
        hits.push(...generic);
      } catch (e) {
      receipt.push(`- 通用web(${provider}):错误 ${String(e?.message ?? e)}`);
      }
    } else {
      receipt.push('- 通用web:未配置 provider(当前=none,仅以上垂直结果;不假装搜过)');
    }
    if (!hits.length) {
      return okText(receipt.join('\n') + '\n\n无结果。建议换关键词或明确目标渠道。');
    }
    // cross-channel dedupe (same url/title) — registry pagination
    // once listed the same server 3x in a row (round-3 review)
    // dedupe: exact url/title, AND cross-channel same-name merges
    // (registry + github often carry the same project — round-3
    // review polish; sources are unioned so nothing is lost)
    const byName = new Map();
    for (const h of hits) {
      const urlKey = h.url ?? h.title;
      if ([...byName.values()].some(e => e.urls.has(urlKey))) continue;
      const k = h.title.split('/').pop().toLowerCase();
      const e = byName.get(k);
      if (e && e.title === h.title) {
        e.urls.add(h.url ?? ''); e.count += 1;
      } else if (!e) {
        byName.set(k, { ...h, urls: new Set([h.url ?? '']), count: 1 });
      } else {
        byName.set(`${k}#${h.title}`, { ...h, urls: new Set([h.url ?? '']), count: 1 });
      }
    }
    const uniq = [...byName.values()].map(e => ({
      ...e,
      url: [...e.urls].filter(Boolean).join(' | '),
    }));
    const shown = uniq.slice(0, 12);
    return okText(receipt.join('\n') + `\n\n候选(去重后 ${uniq.length} 条,显示前 ${shown.length}):\n`
      + shown.map((h, i) =>
        `${i + 1}. ${h.title}\n   ${h.url}\n   ${(h.snippet ?? '').slice(0, 120)}`)
        .join('\n'));
  };

  const searchWeb = {
    name: 'search_web',
    label: '搜索',
    description:
      '[read-only] Tool candidate search. Vertical channels first (MCP '
      + 'official registry, GitHub API, npm/pip in sandbox — all '
      + 'keyless); generic web search as fallback ONLY when a provider '
      + 'is configured. The receipt says which channels answered.',
    executionMode: 'sequential',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
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
    }),
    execute: async (_id, p) => {
      let url = p.url;
      const gh = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url);
      if (gh) url = `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}`;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'spectre-tooling' },
          signal: AbortSignal.timeout(15000) });
        const ctype = res.headers.get('content-type') ?? '';
        const text = await res.text();
        if (ctype.includes('html')) {
          const md = htmlToText(text);
          return okText(`${url}\n\n${md.slice(0, 8000)}`);
        }
        return okText(`${url}\n\n${text.slice(0, 12000)}`);
      } catch (e) {
        return errText(`抓取失败:${e.message}`);
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
      const { access } = await import('node:fs/promises');
      const { HOST, CONTAINER } = await import('./exec-env.mjs');
      const dir = HOST.skills; // probe on the HOST fs
      try {
        await access(`${dir}/${p.agentKey}/${p.name}`);
      } catch {
        return okText(`✗ 技能不存在:${p.agentKey}/${p.name}(先 list_tool_config 核对名称拼写)。`);
      }
      await deleteSkill(p.agentKey, p.name);
      await rebuildMounts();
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
      await saveMcpConfig(cfg.filter(s => s.name !== p.name));
      await rebuildMounts();
      closeMcpConnection(p.name); // kill the pooled stdio child, if any
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
      '[side-effects: runs a detached target-agent session; synchronous '
      + '— may take a minute] Wake ONE business agent and ask it to '
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
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
