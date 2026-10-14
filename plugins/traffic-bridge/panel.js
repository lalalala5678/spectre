// SPECTRE Traffic Bridge — DevTools 面板本体。
// 数据流: chrome.devtools.network.getHAR() → 勾选 → 逐条 entry.getContent()
// 取响应体(截 64KB; 二进制以 base64 返回时如实标注) → 按累计载荷字节自动
// 切批(服务端 body 上限 1MB——50 对×128KB 与之不闭合) → 逐批 POST
// {gateway}/spectre/api/traffic(头 X-Spectre-Key, 由 gateway/spectre-apikey.py
// 生成; 会话 cookie SameSite=Strict 使跨站扩展无法携凭据——API Key 通道
// 即为此设)。
'use strict';

const BODY_CAP = 64 * 1024;      // 单体截断(服务端另有 8K 段截断+标记)
const BATCH_CAP = 50;            // 服务端单次条数上限(/api/traffic)
const BATCH_BYTES = 900 * 1024;  // 单批载荷字节上限(< 服务端 1MB body 上限)

const $ = (id) => document.getElementById(id);
const status = (msg, warn) => {
  $('status').textContent = msg;
  $('status').className = warn ? 'cfg-warn' : '';
};

function cfg() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['gateway', 'apikey'], (c) => resolve(c));
  });
}

function hdrObj(list) {
  const out = {};
  for (const h of list || []) {
    const k = h.name || '';
    if (!k) continue;
    out[k] = out[k] ? `${out[k]}, ${h.value}` : h.value;
  }
  return out;
}

let har = { entries: [] };
const picked = new Set();

function render() {
  const q = $('filter').value.trim().toLowerCase();
  const rows = [];
  for (const [i, e] of har.entries.entries()) {
    const url = e.request?.url ?? '';
    if (q && !url.toLowerCase().includes(q)) continue;
    const st = e.response?.status ?? 0;
    const cls = st >= 500 ? 's2x' : st >= 400 ? 's2e' : 's2r';
    rows.push(
      `<div class="row" data-i="${i}">
        <input type="checkbox" ${picked.has(i) ? 'checked' : ''}>
        <span class="m">${e.request?.method ?? '?'}</span>
        <span class="s2 ${cls}">${st}</span>
        <span class="u">${url.replace(/</g, '&lt;')}</span>
      </div>`);
  }
  $('list').innerHTML = rows.join('') || '<div class="row">无记录(先访问目标页再刷新)</div>';
  $('picked').textContent = `${picked.size} 条`;
  $('count').textContent = `HAR ${har.entries.length} 条`;
}

function loadHar() {
  chrome.devtools.network.getHAR((h) => {
    har = h || { entries: [] };
    for (const i of [...picked]) {
      if (i >= har.entries.length) picked.delete(i);
    }
    render();
  });
}

async function pairOf(entry) {
  const req = entry.request ?? {};
  const res = entry.response ?? {};
  // getContent(text, base64Encoded): 二进制响应(图片/压缩流)以 base64
  // 文本返回——不解码(解码即乱码入库), 如实标注后入库。
  const [body, wasB64] = await new Promise((resolve) => {
    if (typeof entry.getContent !== 'function') return resolve([null, false]);
    entry.getContent((text, b64) => resolve([text ?? null, Boolean(b64)]));
  });
  const clip = (t) => (t == null ? undefined
    : (t.length > BODY_CAP ? t.slice(0, BODY_CAP) : t));
  return {
    request: {
      method: req.method, url: req.url,
      headers: hdrObj(req.headers),
      body: clip(req.postData?.text),
    },
    response: {
      status: res.status,
      headers: hdrObj(res.headers),
      body: body == null ? undefined
        : (wasB64 ? `[base64 编码响应体, ${body.length} 字符]\n${clip(body)}` : clip(body)),
    },
    ...(wasB64 ? { note: '响应为二进制(base64 呈现)' } : {}),
  };
}

/** 按累计载荷字节切批(≤min(BATCH_CAP 条, BATCH_BYTES 字节)/批)。
 *  计量用 UTF-8 字节(TextEncoder)非 .length(UTF-16 码元)——服务端
 *  readJson 按字节计, CJK 体检 3 字节/字, 码元计量会让中文流量批超限。 */
function splitBatches(pairs) {
  const size = new TextEncoder();
  const nOf = (v) => size.encode(v).length;
  const batches = [];
  let cur = [];
  let curBytes = 2; // 数组括号
  for (const p of pairs) {
    const n = nOf(JSON.stringify(p)) + 1;
    if (cur.length && (cur.length >= BATCH_CAP || curBytes + n > BATCH_BYTES)) {
      batches.push(cur);
      cur = [];
      curBytes = 2;
    }
    cur.push(p);
    curBytes += n;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

async function postBatch(gateway, apikey, title, batch) {
  const r = await fetch(`${gateway}/spectre/api/traffic`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Spectre-Key': apikey },
    body: JSON.stringify({ title: title || undefined, pairs: batch }),
  });
  if (r.status === 401) throw new Error('API Key 无效——重新生成(spectre-apikey.py)后更新配置');
  if (r.redirected || (r.status >= 300 && r.status < 400)) throw new Error(`网关地址不对(被重定向)——检查 ${gateway}`);
  if (r.status === 413) throw new Error('批次仍超服务端上限(HTTP 413)——减少单条体积(截断更短)后重试');
  if (!r.ok) throw new Error(`提交失败 HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function send() {
  const c = await cfg();
  if (!c.gateway || !c.apikey) {
    status('未配置: 点扩展图标填网关地址与 API Key(spectre-apikey.py 生成)', true);
    return;
  }
  if (!picked.size) { status('先勾选要送入的流量对', true); return; }
  const idx = [...picked].sort((a, b) => a - b);
  const title = $('title').value.trim();
  status(`取响应体中(0/${idx.length})…`);
  const pairs = [];
  for (const [n, i] of idx.entries()) {
    pairs.push(await pairOf(har.entries[i]));
    status(`取响应体中(${n + 1}/${idx.length})…`);
  }
  const batches = splitBatches(pairs);
  const seqs = [];
  for (const [bi, batch] of batches.entries()) {
    status(`送入批次 ${bi + 1}/${batches.length}(条数 ${batch.length})…`);
    try {
      const batchTitle = bi === 0 || !title ? title : `${title} (续${bi})`;
      const out = await postBatch(c.gateway, c.apikey, batchTitle, batch);
      seqs.push(...out.seqs);
      if (out.note) status(`批次 ${bi + 1}: ${out.note}`, true);
    } catch (e) {
      status(`${e.message}(已入库 ${seqs.length} 条不受影响; 未送批次重试即可)`, true);
      return;
    }
  }
  status(`已入库 ${seqs.length} 条(seq: ${seqs.join(', ')})——席位经 query_intel q=[流量] 可查`);
}

document.addEventListener('DOMContentLoaded', () => {
  $('refresh').addEventListener('click', loadHar);
  $('send').addEventListener('click', send);
  $('filter').addEventListener('input', render);
  $('list').addEventListener('click', (ev) => {
    const row = ev.target.closest('.row');
    if (!row || row.dataset.i === undefined) return;
    const i = Number(row.dataset.i);
    if (picked.has(i)) picked.delete(i); else picked.add(i);
    render();
  });
  loadHar();
});
