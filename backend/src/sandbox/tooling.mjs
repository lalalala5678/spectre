/**
 * Tooling-agent toolkit — the capabilities the `tools` agent uses to
 * DISCOVER, BUILD and CONFIGURE skills / MCP servers / CLI tools for
 * OTHER agents. Design axioms (AGENTS.md):
 *   · the tools agent CONFIGURES mounts for named agents — it never
 *     holds the configured skill/MCP itself (mount isolation is by
 *     agentKey at session creation, unchanged);
 *   · CLI installs are environment-level (shared PATH, 公理二);
 *   · generic web search is an OPTIONAL pluggable provider (default
 *     none — zero vendor lock); the first-class discovery channels are
 *     keyless vertical APIs (MCP registry / GitHub / package managers).
 */
import { Type } from '@earendil-works/pi-ai';

import { saveSkill, deleteSkill, listSkillsTree } from './skills.mjs';
import { saveMcpConfig, loadMcpConfig, testMcpServer } from './mcp.mjs';
import { listInstalledTools, sandboxConfig } from './container.mjs';
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

/** Zero-key vertical channels, tried by query intent. */
async function searchVertical(query) {
  const out = [];
  const q = query.toLowerCase();
  // 1) MCP official registry (keyless)
  try {
    const res = await fetch(`${REGISTRY_BASE}/search?q=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      for (const item of (data.servers ?? data.results ?? []).slice(0, 5)) {
        out.push({ title: item.name ?? item.id,
          url: item.repository ?? item.homepage
            ?? `${REGISTRY_BASE}/servers/${item.id ?? item.name}`,
          snippet: item.description ?? '' });
      }
    }
  } catch { /* registry down — other channels still run */ }
  // 2) GitHub search (keyless, 60 req/h)
  try {
    const kind = /skill/.test(q) ? 'SKILL.md' : /mcp/.test(q) ? 'mcp package.json' : '';
    const ghq = kind ? `${query} ${kind}` : query;
    const res = await fetch(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(ghq)}&per_page=5`,
      { headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      for (const r of (data.items ?? []).slice(0, 5)) {
        out.push({ title: r.full_name, url: r.html_url,
          snippet: (r.description ?? '') + ` ★${r.stargazers_count}` });
      }
    }
  } catch { /* rate-limited or offline */ }
  return out;
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
      return [all.configureSkill, all.listToolConfig, all.searchWeb, all.fetchUrl];
    case 'mcp-config':
      return [all.configureMcp, all.listToolConfig, all.testMcp, all.searchWeb, all.fetchUrl];
    case 'cli-config':
      return [all.listToolConfig, all.searchWeb, all.fetchUrl];
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
      const paths = [];
      for (const key of p.agentKeys.filter(k => AGENT_KEYS.includes(k))) {
        paths.push(await saveSkill(key, p));
      }
      await rebuildMounts();
      return okText(`技能已挂载到 ${paths.length} 个智能体:${p.agentKeys.join(',')}。`
        + '对目标智能体的新会话生效(按需加载:索引入提示,全文需要时自读)。');
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
      const list = (await loadMcpConfig()).filter(s => s.name !== p.name);
      await saveMcpConfig([...list, p]);
      await rebuildMounts();
      return okText(`MCP ${p.name} 已注册并挂载到 ${p.agents.join(',')}(新会话生效)。`
        + '建议立即用 test_mcp_server 验证。');
    },
  };

  const listToolConfig = {
    name: 'list_tool_config',
    label: '查询工具配置',
    description:
      '[read-only] Current tooling landscape: per-agent skills, MCP '
      + 'servers with their mounts, and installed CLI tools.',
    executionMode: 'sequential',
    parameters: Type.Object({}),
    execute: async () => {
      const skills = await listSkillsTree(AGENT_KEYS);
      const mcps = (await loadMcpConfig())
        .map(s => `${s.name}(${s.transport}) → [${(s.agents ?? []).join(',')}]`);
      const cli = await listInstalledTools();
      return okText(
        `技能挂载:\n${skills.map(s => `- ${s.agentKey}: ${s.name}`).join('\n') || '(无)'}\n\n`
        + `MCP 服务器:\n${mcps.map(x => `- ${x}`).join('\n') || '(无)'}\n\n`
        + `沙箱已装命令(节选):\n${cli.slice(0, 60).join(' ') || '(基础镜像)'}`);
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
      let server = p.name
        ? (await loadMcpConfig()).find(s => s.name === p.name) : null;
      if (!server) server = {
        name: p.name ?? 'ad-hoc', transport: p.transport ?? (p.url ? 'http' : 'stdio'),
        url: p.url, headers: p.headers, command: p.command,
        // follow the ACTIVE driver: sandbox only exists for docker
        where: sandboxConfig().driver === 'docker' ? 'sandbox' : 'host',
      };
      const r = await testMcpServer(server);
      return okText(r.ok
        ? `✓ ${r.serverName} 连通,工具:${(r.tools ?? []).join(', ') || '(空)'}`
        : `✗ 连接失败:${r.error}`);
    },
  };

  const searchWeb = {
    name: 'search_web',
    label: '搜索',
    description:
      '[read-only] Tool discovery search. Vertical channels first (MCP '
      + 'official registry, GitHub API, npm/pip in sandbox — all '
      + 'keyless); generic web search as fallback ONLY when a provider '
      + 'is configured. The receipt says which channels answered.',
    executionMode: 'sequential',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
    }),
    execute: async (_id, p) => {
      const parts = [];
      const vertical = await searchVertical(p.query);
      if (vertical.length) {
        parts.push('目录/代码检索:\n' + vertical.map(r =>
          `- ${r.title}\n  ${r.url}\n  ${(r.snippet ?? '').slice(0, 100)}`).join('\n'));
      }
      const prefs = await getPrefs();
      const pcfg = prefs?.search;
      if (pcfg?.provider && pcfg.provider !== 'none' && PROVIDERS[pcfg.provider]) {
        try {
          const generic = await PROVIDERS[pcfg.provider](p.query, pcfg);
          if (generic.length) {
            parts.push('通用 web 搜索:\n' + generic.map(r =>
              `- ${r.title}\n  ${r.url}`).join('\n'));
          }
        } catch (e) {
          parts.push(`通用搜索(${pcfg.provider})失败:${e.message}`);
        }
      } else if (!vertical.length) {
        parts.push('未配置通用 web 搜索 provider(当前=none)。垂直通道无结果;'
          + '可在配置页设置 provider(zhipu/brave/tavily/searxng)增强。');
      }
      return okText(parts.join('\n\n') || '无结果');
    },
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

  return { configureSkill, configureMcp, listToolConfig, testMcp,
    searchWeb, fetchUrl };
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
