/**
 * Minimal HTTP helpers for the agent runtime: JSON responses, request body
 * reading with size caps, and SSE stream setup with keep-alive pings.
 */

import { CONFIG } from './config.mjs';

export function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > CONFIG.maxBodyBytes) {
      throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString() || '{}';
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { statusCode: 400 });
  }
}

export function sse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');
  // R26-F4: ping 连续 4 次(≈60s)写入背压——缓冲拥塞未排空的半开连
  // 接主动断链, 防 ping+delta+重放无限积压(客户端可凭 since 重连)。
  let congested = 0;
  const ping = setInterval(() => {
    if (res.write(':ping\n\n')) congested = 0;
    else if (++congested >= 4) { clearInterval(ping); res.destroy(); }
  }, 15_000);
  req.on('close', () => clearInterval(ping));
  return res;
}

export function hasInternalToken(req) {
  return req.headers['x-internal-token'] === CONFIG.internalToken;
}

/** F75/R1-F1: 直连内部判定——token 匹配且不携带网关注入的来源标记。
 * 网关为所有已认证控制台请求注入 X-Internal-Token, 使历史上全部
 * internal-only 子门对控制台用户恒真(注释声称的权限模型是死代码)。
 * 网关现随 token 附带 X-Console-Origin: 1(服务端构造, 客户端不可
 * 伪造——proxy.py 的上游头集合不含任何透传); 子门改用本判定后,
 * 控制台来源恰好被拒, 与各子门注释意图一致。gatedRoute 仍用
 * hasInternalToken(统一门只挡本机直连无 token 的进程)。 */
export function isInternalCaller(req) {
  return hasInternalToken(req) && !req.headers['x-console-origin'];
}

/** Read the raw request body as a Buffer (size-capped like readJson). */
export async function readRawBody(req, maxBytes) {
  const cap = maxBytes ?? 100 * 1024 * 1024; // 100MB upload ceiling
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) {
      throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Minimal multipart/form-data parser (single-file + optional fields).
 * The console upload form is the only producer — no RFC edge cases.
 */
export function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!m) throw Object.assign(new Error('multipart boundary missing'), { statusCode: 400 });
  const boundary = `--${m[1] ?? m[2]}`;
  const fields = {};
  let file = null;
  const sections = [];
  let idx = body.indexOf(boundary);
  while (idx >= 0) {
    const next = body.indexOf(boundary, idx + boundary.length);
    if (next < 0) break;
    sections.push(body.subarray(idx + boundary.length + 2, next - 2));
    idx = next;
  }
  for (const sec of sections) {
    const headerEnd = sec.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const head = sec.subarray(0, headerEnd).toString('utf8');
    const content = sec.subarray(headerEnd + 4);
    const nameM = /name="([^"]*)"/.exec(head);
    const fileM = /filename="([^"]*)"/.exec(head);
    if (fileM && nameM) {
      file = { field: nameM[1], filename: fileM[1].replace(/[\/]/g, '_'),
        data: content };
    } else if (nameM) {
      fields[nameM[1]] = content.toString('utf8');
    }
  }
  return { fields, file };
}
