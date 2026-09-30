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

// R32D35-F2: 数据根走 SPECTRE_DATA_DIR(同 F1; where:'host' 时无
// /opt/tools 挂载, 此前回落生产路径读到生产 NVD key)。
import { join } from 'node:path';
const cfg = (() => {
  const p = join(process.env.SPECTRE_DATA_DIR ?? '/var/lib/spectre',
    'tools/nday/api-keys.json');
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { /* none */ }
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
  const clipMark = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const desc = (cve.descriptions ?? []).find(d => d.lang === 'en')?.value
    ?? (cve.descriptions ?? [])[0]?.value ?? '';
  // CVSS 带 版本标签(v2/v3.x 混排此前可误读为"CVSS 2.1")
  const m31 = cve.metrics?.cvssMetricV31?.[0];
  const m30 = cve.metrics?.cvssMetricV30?.[0];
  const m2 = cve.metrics?.cvssMetricV2?.[0];
  const m = m31 ?? m30 ?? m2;
  const ver = m31 ? 'v3.1' : m30 ? 'v3.0' : m2 ? 'v2' : '?';
  const score = m?.cvssData?.baseScore ?? '?';
  const vector = m?.cvssData?.vectorString ?? '';
  const cwe = (cve.weaknesses ?? [])[0]?.description?.[0]?.value ?? '';
  // CPE 全量遍历所有 configuration(nday R1 实测: 此前只取首个配置的
  // 前 3 条, CVE-2021-44228 呈现的全是 Siemens 固件——影响面误判)
  const allCpes = [];
  const seen = new Set();
  for (const conf of cve.configurations ?? []) {
    for (const node of conf?.nodes ?? []) {
      for (const cm of node.cpeMatch ?? []) {
        if (cm.criteria && !seen.has(cm.criteria)) {
          seen.add(cm.criteria); allCpes.push(cm.criteria);
        }
      }
    }
  }
  const cpeLine = allCpes.length
    ? `  影响: 共 ${allCpes.length} 个 CPE${allCpes.length > 3 ? `(显示前 3,按上游配置序; 全量影响面以 cvelistV5/cpe 参数检索为准)`: ''}: ${allCpes.slice(0, 3).join(' | ')}`
    : '  影响: (无 CPE 数据)';
  const refsAll = cve.references ?? [];
  const refs = refsAll.slice(0, 2).map(r => r.url);
  return [`✓ ${cve.id} · CVSS ${score}(${ver})${vector ? ` ${clipMark(vector, 60)}` : ''}${cwe ? ` · ${cwe}` : ''}`,
    cpeLine,
    `  描述: ${clipMark(desc, 300)}`,
    refs.length ? `  Ref: 共 ${refsAll.length} 条(显示 2): ${refs.join(' ')}` : '',
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
  // 检索模式:keyword 优先,cpe 次之;日期窗必须成对(单传静默失效是坑)
  const params = { resultsPerPage: String(Math.min(Number(a.size) || 5, 20)) };
  if (a.start !== undefined) params.startIndex = String(Math.max(0, Number(a.start) || 0));
  if (a.keyword) params.keywordSearch = String(a.keyword);
  else if (a.cpe) params.virtualMatchString = String(a.cpe);  // 前缀匹配语义(cpeName 要求全量精确, 无版本恒 0 命中)
  else if (a.pubStartDate || a.pubEndDate) {
    if (!a.pubStartDate || !a.pubEndDate) {
      return '✗ 日期窗检索需 pubStartDate+pubEndDate 成对(ISO8601), 单传不生效';
    }
    params.pubStartDate = String(a.pubStartDate);
    params.pubEndDate = String(a.pubEndDate);
  }
  const r = await nvdGet(params);
  if (r.err) return `✗ ${r.err}`;
  const vulns = r.body?.vulnerabilities ?? [];
  if (!vulns.length) return `✗ 无命中:keyword 换检索词, 或 cpe 用前缀形式(如 cpe:2.3:a:apache:log4j)`;
  const startAt = Number(params.startIndex ?? 0);
  return `共 ${r.body?.totalResults ?? '?'} 条,显示 ${startAt + 1}-${startAt + vulns.length}${Number(r.body?.totalResults ?? 0) > startAt + vulns.length ? `(继续翻页: start=${startAt + vulns.length})` : ''}:\n\n`
    + vulns.map(v => fmtCve(v.cve)).join('\n\n');
}

const TOOL = {
  name: 'nvd_cve',
  desc: ('[read-only] NVD 2.0 查询:按 CVE 编号取详情(CVSS/CWE/CPE/描述/参考),'
    + '或按 keyword/cpe 检索候选(keyless 5req/30s,已配 key 50req/30s)。'
    + '用于 CVE 候选台账构建与 CPE 标准化(本地 cvelistV5 之外的权威第四源)。'
    + ' NVD API 不支持排序(结果为上游默认序, 新旧混杂)——按时间收敛用'
    + ' pubStartDate+pubEndDate 日期窗, 深翻用 start。'),
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
          start: { type: 'number', description: '翻页偏移 startIndex(默认 0, 与 size 配合取全量)' },
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
