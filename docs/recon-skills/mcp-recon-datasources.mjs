#!/usr/bin/env node
/**
 * SPECTRE recon-datasources MCP server (stdio).
 *
 * One server, N data-source tools. Tools are listed ONLY for sources whose
 * secrets are configured (user's zero-pollution rule: an unconfigured
 * source must not appear in the agent's toolface at all).
 *
 * Config file: /var/lib/spectre/recon-datasources.json — written by the
 * settings save path (backend/src/settings.mjs writes it on every
 * recon-source save; validators run BEFORE the file is updated).
 *
 * Transport: minimal JSON-RPC over stdio (same wire format as mcp-echo).
 */
import readline from 'node:readline';
import { readFileSync } from 'node:fs';

const CFG_PATH = '/var/lib/spectre/recon-datasources.json';
let cfg = {};
try { cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8')); } catch { /* none configured */ }

const enc = encodeURIComponent;
const J = (o) => JSON.stringify(o);

async function call(url, init = {}, timeoutMs = 25000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { }
  return { status: res.status, body, text };
}
const clip = (s, n = 6000) => (s && s.length > n ? `${s.slice(0, n)}…[截断,len=${s.length}]` : s);

/* ---------------- source adapters: query(text, size) → receipt text ------ */
const SOURCES = {
  fofa: {
    tool: 'fofa_query',
    desc: '[read-only] FOFA 资产检索。query 用 FOFA 完整语法(domain="x.com" / icp="备案号" / ip="1.2.3.4" / icon_hash=…)。size 默认 100。',
    async query(a) {
      const { baseUrl, email, key } = cfg.fofa ?? {};
      const base = baseUrl || 'https://fofa.info/api';
      const q = Buffer.from(a.query).toString('base64');
      const r = await call(`${base}/v1/search/all?email=${enc(email)}&key=${enc(key)}&qbase64=${enc(q)}&size=${a.size ?? 100}&fields=host,ip,port,title,server`);
      if (r.body?.error !== null && r.body?.error !== undefined) return `✗ FOFA: ${r.body?.errmsg ?? r.status}`;
      const rows = (r.body?.results ?? []).map(x => Array.isArray(x) ? x.join('|') : J(x));
      return `✓ FOFA ${r.body?.size ?? rows.length} 条(共 ${r.body?.size ?? '?'}):\n` + clip(rows.join('\n'));
    },
  },
  hunter: {
    tool: 'hunter_query',
    desc: '[read-only] 鹰图 Hunter 资产检索。query 用 Hunter 语法(domain.suffix="x.com" / ip="1.2.3.4")。',
    async query(a) {
      const { key } = cfg.hunter ?? {};
      const r = await call(`https://hunter.qianxin.com/openApi/search?api-key=${enc(key)}&search=${enc(Buffer.from(a.query).toString('base64'))}&page=1&page_size=${a.size ?? 100}&is_web=3`);
      if (r.body?.code !== 200) return `✗ Hunter: ${r.body?.message ?? r.status}`;
      const rows = (r.body?.data?.arr ?? []).map(x => `${x.url}|${x.ip}|${x.port}|${x.web_title}|${x.component}`);
      return `✓ Hunter ${rows.length} 条(配额剩余 ${r.body?.data?.rest_quota ?? '?'}):\n` + clip(rows.join('\n'));
    },
  },
  quake: {
    tool: 'quake_query',
    desc: '[read-only] Quake360 资产检索。query 用 Quake 语法(domain:"x.com")。',
    async query(a) {
      const { key } = cfg.quake ?? {};
      const r = await call('https://quake.360.net/api/v3/search/quake_service', {
        method: 'POST',
        headers: { 'X-QuakeToken': key, 'Content-Type': 'application/json' },
        body: J({ query: a.query, start: 0, size: a.size ?? 100, include: ['ip', 'port', 'hostname', 'service.http.title', 'service.http.server'] }),
      });
      if (r.body?.code !== 0) return `✗ Quake: ${r.body?.message ?? r.status}`;
      const rows = (r.body?.data ?? []).map(x => `${x.hostname ?? '-'}|${x.ip}|${x.port}|${x.service?.http?.title ?? ''}`);
      return `✓ Quake ${rows.length} 条:\n` + clip(rows.join('\n'));
    },
  },
  zoomeye: {
    tool: 'zoomeye_query',
    desc: '[read-only] ZoomEye 资产检索。query 用 ZoomEye 语法(site:"x.com")。type: host/web。',
    async query(a) {
      const { key } = cfg.zoomeye ?? {};
      const t = a.type === 'host' ? 'host/search' : 'web/search';
      const r = await call(`https://api.zoomeye.org/${t}?query=${enc(a.query)}&page=1`, { headers: { 'API-KEY': key } });
      if (r.status !== 200) return `✗ ZoomEye: HTTP ${r.status} ${clip(r.text, 200)}`;
      const list = r.body?.matches ?? r.body?.list ?? [];
      return `✓ ZoomEye ${list.length} 条(总 ${r.body?.total ?? '?'}):\n` + clip(list.map(x => J(x).slice(0, 200)).join('\n'));
    },
  },
  censys: {
    tool: 'censys_query',
    desc: '[read-only] Censys 2.0 检索(hosts/certs)。query 用 Censys 语法。',
    async query(a) {
      const { id, secret } = cfg.censys ?? {};
      const idx = a.index === 'certs' ? 'certificates' : 'hosts';
      const r = await call(`https://search.censys.io/api/v2/${idx}/search?q=${enc(a.query)}&per_page=${a.size ?? 100}`, {
        headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` },
      });
      if (r.body?.code !== 200) return `✗ Censys: ${r.body?.error ?? r.status}`;
      const rows = (r.body?.result?.hits ?? []).map(x => J(x).slice(0, 220));
      return `✓ Censys ${rows.length} 条:\n` + clip(rows.join('\n'));
    },
  },
  shodan: {
    tool: 'shodan_query',
    desc: '[read-only] Shodan 检索。query 用 Shodan 语法(hostname:x.com)。',
    async query(a) {
      const { key } = cfg.shodan ?? {};
      const r = await call(`https://api.shodan.io/shodan/host/search?key=${enc(key)}&query=${enc(a.query)}&page=1&limit=${a.size ?? 100}`);
      if (r.body?.error) return `✗ Shodan: ${r.body.error}`;
      const rows = (r.body?.matches ?? []).map(x => `${x.ip_str}:${x.port}|${x.hostnames?.join(',')}|${(x.data || '').split('\n')[0]}`);
      return `✓ Shodan ${rows.length} 条(总 ${r.body?.total ?? '?'}):\n` + clip(rows.join('\n'));
    },
  },
  github: {
    tool: 'github_search',
    desc: '[read-only] GitHub 代码/仓库搜索(token 已配)。kind: code/repositories。',
    async query(a) {
      const { token } = cfg.github ?? {};
      const kind = a.kind === 'repositories' ? 'repositories' : 'code';
      const r = await call(`https://api.github.com/search/${kind}?q=${enc(a.query)}&per_page=${a.size ?? 30}`, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'spectre', Accept: 'application/vnd.github+json' },
      });
      if (r.status === 403 && /rate limit/i.test(r.text ?? '')) return '✗ GitHub: token 限流,稍后再试';
      if (r.status !== 200) return `✗ GitHub: HTTP ${r.status}`;
      const items = kind === 'code'
        ? (r.body?.items ?? []).map(x => `${x.repository.full_name}|${x.path}|${x.html_url}`)
        : (r.body?.items ?? []).map(x => `${x.full_name}|⭐${x.stargazers_count}|${x.description ?? ''}`);
      return `✓ GitHub ${items.length} 条(总 ${r.body?.total_count ?? '?'}):\n` + clip(items.join('\n'));
    },
  },
  cse: {
    tool: 'cse_search',
    desc: '[read-only] Google CSE 搜索(完整 Google dork 语法:site:/filetype:/intitle:)。比搜索引擎抓取可靠,机器可读。',
    async query(a) {
      const { key, cx } = cfg.cse ?? {};
      const r = await call(`https://www.googleapis.com/customsearch/v1?key=${enc(key)}&cx=${enc(cx)}&q=${enc(a.query)}&num=10&start=${a.start ?? 1}`);
      if (r.body?.error) return `✗ CSE: ${r.body.error.message}`;
      const items = (r.body?.items ?? []).map(x => `${x.title}\n  ${x.link}\n  ${(x.snippet ?? '').slice(0, 150)}`);
      return `✓ Google CSE ${items.length} 条(总 ${r.body?.searchInformation?.totalResults ?? '?'}):\n` + clip(items.join('\n'));
    },
  },
  ipinfo: {
    tool: 'ipinfo_lookup',
    desc: '[read-only] IP 归属/ASN/geo 查询(C 段归属判定用)。',
    async query(a) {
      const { token } = cfg.ipinfo ?? {};
      const r = await call(`https://ipinfo.io/${enc(a.ip)}/json?token=${enc(token)}`);
      if (r.body?.error) return `✗ IPinfo: ${r.body.error.title ?? r.body.error}`;
      return `✓ ${J(r.body)}`;
    },
  },
  threatbook: {
    tool: 'threatbook_dns',
    desc: '[read-only] 微步被动 DNS/域名情报(历史解析、CDN 源站定位用)。',
    async query(a) {
      const { key } = cfg.threatbook ?? {};
      const r = await call(`https://x.threatbook.com/api/v2/domain/query?apikey=${enc(key)}&domain=${enc(a.domain)}`);
      if (r.body?.response_code !== 0) return `✗ 微步: ${r.body?.verbose_msg ?? r.status}`;
      return `✓ ${clip(J(r.body))}`;
    },
  },
};

const active = Object.entries(SOURCES).filter(([id]) => {
  const c = cfg[id] ?? {};
  return Boolean(c.key || c.token || c.secret || c.id);
});

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  let result;
  if (m.method === 'initialize') {
    result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'recon-datasources' } };
  } else if (m.method === 'tools/list') {
    result = { tools: active.map(([id, s]) => ({
      name: s.tool, description: s.desc,
      inputSchema: { type: 'object', properties: {
        query: { type: 'string', description: id === 'ipinfo' ? 'unused' : '检索式' },
        ip: { type: 'string', description: 'ipinfo 用:IP 地址' },
        domain: { type: 'string', description: 'threatbook 用:域名' },
        size: { type: 'number' }, kind: { type: 'string' }, index: { type: 'string' }, type: { type: 'string' }, start: { type: 'number' },
      } },
    })) };
  } else if (m.method === 'tools/call') {
    const name = m.params?.name;
    const s = active.find(([, x]) => x.tool === name);
    if (!s) {
      result = { content: [{ type: 'text', text: `✗ 工具未挂载(该数据源未配置):${name}` }] };
    } else {
      // async bridge — respond out-of-band is not possible on stdio sync loop;
      // queue via promise chain to preserve ordering
      s[1].query(m.params?.arguments ?? {}).then(text => {
        process.stdout.write(J({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }] } }) + '\n');
      }).catch(e => {
        process.stdout.write(J({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `✗ 调用失败:${String(e?.message ?? e).slice(0, 300)}` }] } }) + '\n');
      });
      return; // async response
    }
  } else {
    result = {};
  }
  process.stdout.write(J({ jsonrpc: '2.0', id: m.id, result }) + '\n');
});
