#!/usr/bin/env node
/**
 * mcp-nday-intel — NDay Agent 情报 MCP(stdio)
 *
 * Config: /opt/tools/nday/api-keys.json 形如 {"nvd":{"key":"..."}}
 * (设置面板「NDay Agent」组验证后落盘;env NVD_API_KEY 兜底)。
 * 无 key 也可跑(NVD 免费层 5req/30s,进程内限流器兜住);
 * 有 key 限流自动升 50req/30s。
 *
 * 设计规约(对齐 mcp-recon-datasources / AGENTS.md):
 * - 工具侧错误以 result.isError 报告(MCP 2025-06-18),不用协议级 error
 * - 必填参数运行时校验,缺失=引导性拒绝而非裸异常
 * - 未知方法 -32601;畸形行跳过不崩
 * - 密钥永不回显
 */
import readline from 'node:readline';
import { readFileSync } from 'node:fs';

const cfg = (() => {
  for (const p of ('/opt/tools/nday/api-keys.json',
                   '/var/lib/spectre/tools/nday/api-keys.json')) {
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { /* next */ }
  }
  return {};
})();
const NVD_KEY = cfg?.nvd?.key || process.env.NVD_API_KEY || '';
const BASE = 'https://services.nvd.nist.gov/rest/json/cves/2.0';

/** 进程内滑动窗限流:keyless 5/30s(官方免费层),keyed 50/30s。 */
const RATE = { max: NVD_KEY ? 50 : 5, win: 30_000, hits: [] };
function rateAllow() {
  const now = Date.now();
  RATE.hits = RATE.hits.filter(t => now - t < RATE.win);
  if (RATE.hits.length >= RATE.max) {
    const wait = Math.ceil((RATE.win - (now - RATE.hits[0])) / 1000);
    return { ok: false, wait };
  }
  RATE.hits.push(now);
  return { ok: true };
}

async function nvdGet(params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}?${qs}`, {
    headers: NVD_KEY ? { apiKey: NVD_KEY } : {},
    signal: AbortSignal.timeout(25_000),
  });
  if (res.status === 403) {
    return { err: 'NVD 限流(403):请等 30s 重试,或配置 key 升 50req/30s(设置面板→NDay Agent)' };
  }
  if (res.status === 404) return { notFound: true };
  if (!res.ok) return { err: `NVD HTTP ${res.status}` };
  return { body: await res.json() };
}

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function fmtCve(cve) {
  const desc = (cve.descriptions ?? []).find(d => d.lang === 'en')?.value
    ?? (cve.descriptions ?? [])[0]?.value ?? '';
  const m = cve.metrics?.cvssMetricV31?.[0] ?? cve.metrics?.cvssMetricV30?.[0]
    ?? cve.metrics?.cvssMetricV2?.[0];
  const score = m?.cvssData?.baseScore ?? '?';
  const vector = m?.cvssData?.vectorString ?? '';
  const cwe = (cve.weaknesses ?? [])[0]?.description?.[0]?.value ?? '';
  const cpes = [];
  for (const node of cve.configurations?.[0]?.nodes ?? []) {
    for (const cm of node.cpeMatch ?? []) {
      if (cm.criteria) cpes.push(cm.criteria);
      if (cpes.length >= 3) break;
    }
    if (cpes.length >= 3) break;
  }
  const refs = (cve.references ?? []).slice(0, 2).map(r => r.url);
  return [`✓ ${cve.id} · CVSS ${score}${vector ? ` (${clip(vector, 60)})` : ''}${cwe ? ` · ${cwe}` : ''}`,
    `  影响: ${cpes.join(' | ') || '(无 CPE 数据)'}`,
    `  描述: ${clip(desc, 260)}`,
    refs.length ? `  Ref: ${refs.join(' ')}` : '',
  ].filter(Boolean).join('\n');
}

async function query(a) {
  if (a.id) {
    const r = await nvdGet({ cveId: String(a.id).trim().toUpperCase() });
    if (r.err) return `✗ ${r.err}`;
    if (r.notFound) return `✗ NVD 无此 CVE:${a.id}(确认编号,或查 cvelistV5 本地库)`;
    const v = r.body?.vulnerabilities?.[0]?.cve;
    if (!v) return `✗ NVD 返回空:${a.id}`;
    return fmtCve(v);
  }
  // 检索模式:keyword 优先,cpe 次之
  const params = { resultsPerPage: String(Math.min(Number(a.size) || 5, 20)) };
  if (a.keyword) params.keywordSearch = String(a.keyword);
  else if (a.cpe) params.cpeName = String(a.cpe);
  else if (a.pubStartDate) {
    params.pubStartDate = a.pubStartDate; params.pubEndDate = a.pubEndDate;
  }
  const r = await nvdGet(params);
  if (r.err) return `✗ ${r.err}`;
  const vulns = r.body?.vulnerabilities ?? [];
  if (!vulns.length) return `✗ 无命中(总结果 ${r.body?.totalResults ?? 0}):换关键词或用 cpe 精确匹配`;
  return `共 ${r.body?.totalResults ?? '?'} 条,显示 ${vulns.length} 条:\n\n`
    + vulns.map(v => fmtCve(v.cve)).join('\n\n');
}

const TOOL = {
  name: 'nvd_cve',
  desc: ('[read-only] NVD 2.0 查询:按 CVE 编号取详情(CVSS/CWE/CPE/描述/参考),'
    + '或按 keyword/cpe 检索候选(keyless 5req/30s,已配 key 50req/30s)。'
    + '用于 CVE 候选台账构建与 CPE 标准化(本地 cvelistV5 之外的权威第四源)。'),
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id,
      result: { protocolVersion: '2025-06-18', capabilities: {},
        serverInfo: { name: 'nday-intel' } } }) + '\n');
    return;
  }
  if (m.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id,
      result: { tools: [{ name: TOOL.name, description: TOOL.desc,
        inputSchema: { type: 'object', properties: {
          id: { type: 'string', description: 'CVE 编号,如 CVE-2024-3400(单查模式)' },
          keyword: { type: 'string', description: '产品/组件关键词检索' },
          cpe: { type: 'string', description: 'CPE 名精确匹配,如 cpe:2.3:a:apache:log4j' },
          size: { type: 'number', description: '检索条数(默认 5,上限 20)' },
          pubStartDate: { type: 'string', description: '发布窗起(ISO8601,需配 pubEndDate)' },
          pubEndDate: { type: 'string', description: '发布窗止(ISO8601)' },
        } } }] } }) + '\n');
    return;
  }
  if (m.method === 'tools/call') {
    const reply = (text, isError) => process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: m.id,
      result: { content: [{ type: 'text', text }], isError: Boolean(isError) },
    }) + '\n');
    if (m.params?.name !== TOOL.name) {
      reply(`✗ 工具未挂载:${m.params?.name}`, true); return;
    }
    const a = m.params?.arguments ?? {};
    if (!a.id && !a.keyword && !a.cpe && !a.pubStartDate) {
      reply('✗ 缺少查询目标:id / keyword / cpe / (pubStartDate+pubEndDate) 必给其一', true);
      return;
    }
    const gate = rateAllow();
    if (!gate.ok) {
      reply(`✗ 本进程限流窗已满(${RATE.max}req/30s),约 ${gate.wait}s 后重试;配置 NVD key 可升 50req/30s`, true);
      return;
    }
    query(a).then(text => reply(text, /^✗/.test(text)))
      .catch(e => reply(`✗ 调用失败:${String(e?.message ?? e).slice(0, 200)}`, true));
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id,
    error: { code: -32601, message: 'Method not found' } }) + '\n');
});
