#!/usr/bin/env node
/**
 * SPECTRE recon-datasources MCP server (stdio).
 *
 * One server, N data-source tools. Tools are listed ONLY for sources whose
 * secrets are configured (user's zero-pollution rule: an unconfigured
 * source must not appear in the agent's toolface at all).
 *
 * Config file: $SPECTRE_DATA_DIR/recon-datasources.json — written by the
 * settings save path (backend/src/settings.mjs writes it on every
 * recon-source save; validators run BEFORE the file is updated).
 *
 * Transport: minimal JSON-RPC over stdio (same wire format as mcp-echo).
 */
import readline from 'node:readline';
import { readFileSync } from 'node:fs';

// R32D35-F1: 数据根走 SPECTRE_DATA_DIR(env 由 runtime 注入, 见
// sandbox/mcp.mjs 注入面)——硬编码曾使隔离实例读到生产凭据、新机配置
// 永不挂载。keyfiles.mjs 写入同源路径。
import { join } from 'node:path';
const CFG_PATH = join(process.env.SPECTRE_DATA_DIR ?? '/var/lib/spectre',
  'recon-datasources.json');
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
    desc: '[read-only] FOFA 资产检索。参数: query(必填,FOFA 完整语法 domain="x.com" / icp="备案号" / ip="1.2.3.4" / icon_hash=…), size(可选,默认 100)。仅此两参。',
    async query(a) {
      const { baseUrl, email, key } = cfg.fofa ?? {};
      const base = baseUrl || 'https://fofa.info/api';
      const q = Buffer.from(a.query).toString('base64');
      const r = await call(`${base}/v1/search/all?email=${enc(email)}&key=${enc(key)}&qbase64=${enc(q)}&size=${a.size ?? 100}&fields=host,ip,port,title,server`);
      // FOFA 成功体是 "error":false(布尔)——此前 !==null 谓词把成功
      // 误判为失败(回执"✗ FOFA: 200"自相矛盾, agent 实测抓出)。
      if (r.body?.error) {
        const msg = r.body?.errmsg || clip(J(r.body), 200);
        const quota = /配额|quota|积分|f[- ]?point|权限/i.test(String(msg)) ? '(账号配额/权限不足——面板换 key 或升级套餐)' : '';
        return `✗ FOFA: ${msg} ${quota}`;
      }
      const rows = (r.body?.results ?? []).map(x => Array.isArray(x) ? x.join('|') : J(x));
      return `✓ FOFA ${r.body?.size ?? rows.length} 条(共 ${r.body?.size ?? '?'}):\n` + clip(rows.join('\n'));
    },
  },
  hunter: {
    tool: 'hunter_query',
    desc: '[read-only] 鹰图 Hunter 资产检索。参数: query(必填,Hunter 语法 domain.suffix="x.com" / ip="1.2.3.4"), size(可选,默认 100)。仅此两参。',
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
    desc: '[read-only] Quake360 资产检索。参数: query(必填,Quake 语法 domain:"x.com"), size(可选,默认 100)。回执列: 子域|IP|端口|标题, 含总数。仅此两参。',
    async query(a) {
      const { key } = cfg.quake ?? {};
      const r = await call('https://quake.360.net/api/v3/search/quake_service', {
        method: 'POST',
        headers: { 'X-QuakeToken': key, 'Content-Type': 'application/json' },
        body: J({ query: a.query, start: 0, size: a.size ?? 100, include: ['ip', 'port', 'hostname', 'service.http.host', 'service.http.title', 'service.http.server'] }),
      });
      if (r.body?.code !== 0) return `✗ Quake: ${r.body?.message ?? r.status}`;
      // hostname 常为空串(非 null)——?? 不越空串, 此前子域列被空串
      // 短路(agent 六轮实测抓出);用 || 落到 service.http.host。
      const total = r.body?.meta?.pagination?.total;
      const rows = (r.body?.data ?? []).map(x => `${x.hostname || x.service?.http?.host || '-'}|${x.ip}|${x.port}|${x.service?.http?.title || ''}`);
      return `✓ Quake ${rows.length} 条${total !== undefined ? `(共 ${total})` : ''}:\n` + clip(rows.join('\n'));
    },
  },
  zoomeye: {
    tool: 'zoomeye_query',
    desc: '[read-only] ZoomEye 资产检索。参数: query(必填,语法 site:"x.com"), type(可选 host/web)。仅此两参。',
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
    desc: '[read-only] Censys 2.0 检索。参数: query(必填), index(可选 hosts/certs), size(可选)。仅此三参。',
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
    desc: '[read-only] Shodan 检索。参数: query(必填,语法 hostname:x.com), size(可选)。仅此两参。',
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
    desc: '[read-only] GitHub 代码/仓库搜索。参数: query(必填,支持限定符), kind(可选 code/repositories), size(可选)。仅此三参。',
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
    desc: '[read-only] Google CSE 搜索(完整 dork 语法 site:/filetype:/intitle:)。参数: query(必填), start(可选,页起点)。仅此两参。',
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
    desc: '[read-only] IP 归属/ASN/geo 查询。参数: ip(必填)。仅此一参。',
    async query(a) {
      const { token } = cfg.ipinfo ?? {};
      const r = await call(`https://ipinfo.io/${enc(a.ip)}/json?token=${enc(token)}`);
      if (r.body?.error) return `✗ IPinfo: ${r.body.error.title ?? r.body.error}`;
      return `✓ ${J(r.body)}`;
    },
  },
  threatbook: {
    tool: 'threatbook_dns',
    desc: '[read-only] 微步被动 DNS/域名情报。参数: domain(必填)。仅此一参。',
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
  // R25-F2: id 是参数型字段非凭据(R10-F1)——计入闸门令 id-only
  // censys 挂载 Basic base64("id:undefined") 必败工具, 违反零污染
  // 契约; 与 save/verify/enabledReconSources 三处规范谓词对齐。
  return Boolean(c.key || c.token || c.secret);
});

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  let result;
  if (m.method === 'initialize') {
    result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'recon-datasources' } };
  } else if (m.method === 'tools/list') {
    // 每工具只保留真实生效的参数(agent 实测反馈: 共享 schema 的
    // "threatbook 用"类互引描述造成传参歧义)
    const q = d => ({ type: 'string', description: d });
    const sizeP = { type: 'number', description: '返回条数(默认 100)' };
    const SCHEMAS = {
      fofa: { query: q('FOFA 完整语法检索式, 如 domain="x.com" 或 icp="备案号"'), size: sizeP },
      hunter: { query: q('Hunter 语法检索式, 如 domain.suffix="x.com"'), size: sizeP },
      quake: { query: q('Quake 语法检索式, 如 domain:"x.com"'), size: sizeP },
      zoomeye: { query: q('ZoomEye 语法检索式, 如 site:"x.com"'),
        type: { type: 'string', enum: ['host', 'web'], description: '检索面(默认 web)' } },
      censys: { query: q('Censys 2.0 语法检索式'), index: { type: 'string', enum: ['hosts', 'certs'], description: '索引(默认 hosts)' }, size: sizeP },
      shodan: { query: q('Shodan 语法检索式, 如 hostname:x.com'), size: sizeP },
      github: { query: q('搜索词(支持 GitHub 限定符, 如 memshell in:name language:java)'),
        kind: { type: 'string', enum: ['code', 'repositories'], description: '默认 code' }, size: sizeP },
      cse: { query: q('Google 完整 dork 语法, 如 site:x.com filetype:xlsx'),
        start: { type: 'number', description: '结果页起点(默认 1, 每页 10)' } },
      ipinfo: { ip: q('IP 地址, 如 8.8.8.8') },
      threatbook: { domain: q('域名, 如 a.com') },
    };
    result = { tools: active.map(([id, s]) => ({
      name: s.tool, description: s.desc,
      inputSchema: { type: 'object', properties: SCHEMAS[id] ?? { query: q('检索式') },
        required: [id === 'ipinfo' ? 'ip' : id === 'threatbook' ? 'domain' : 'query'] },
    })) };
  } else if (m.method === 'tools/call') {
    const name = m.params?.name;
    const s = active.find(([, x]) => x.tool === name);
    // MCP 2025-06-18: 工具侧错误以 result.isError 报告(非协议级 error),
    // in-repo 桥接(mcp.mjs details.isError)已接此管线。
    // 回执头部复读请求参数(agent 实测反馈: 审计链不再依赖调用方自记)
    // CS44-F1: a 先于 reply 定义(此前未挂载路径先调 reply 引用 a——
    // TDZ ReferenceError, "✗ 工具未挂载"诊断永不可达, 击穿 AGENTS 原则4)。
    const a = m.params?.arguments ?? {};
    const reply = (text, isError) => process.stdout.write(J({
      jsonrpc: '2.0', id: m.id,
      result: { content: [{ type: 'text', text: `[${name} ${J(a)}]\n${text}` }], isError: Boolean(isError) },
    }) + '\n');
    if (!s) {
      reply(`✗ 工具未挂载(该数据源未配置):${name}`, true);
      return;
    }
    // R25-F4: 必填参数运行时校验——缺参此前打到 /undefined 等携凭据
    // 垃圾上游请求(配额灼烧)。运行时守卫胜过 schema 复杂度(tooling
    // 先例)。
    const required = s[0] === 'ipinfo' ? 'ip' : s[0] === 'threatbook' ? 'domain' : 'query';
    if (!a[required]) { reply(`✗ 缺少必填参数 ${required}`, true); return; }
    // async bridge — respond out-of-band is not possible on stdio sync loop;
    // queue via promise chain to preserve ordering
    s[1].query(a).then(text => {
      reply(text, /^✗/.test(String(text)));
    }).catch(e => {
      reply(`✗ 调用失败:${String(e?.message ?? e).slice(0, 300)}`, true);
    });
    return; // async response
  } else {
    // JSON-RPC 2.0: 未知方法 MUST -32601(回空 result 是假成功)
    process.stdout.write(J({ jsonrpc: '2.0', id: m.id,
      error: { code: -32601, message: 'Method not found' } }) + '\n');
    return;
  }
  process.stdout.write(J({ jsonrpc: '2.0', id: m.id, result }) + '\n');
});
