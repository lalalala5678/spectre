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
  const ping = setInterval(() => res.write(':ping\n\n'), 15_000);
  req.on('close', () => clearInterval(ping));
  return res;
}

export function hasInternalToken(req) {
  return req.headers['x-internal-token'] === CONFIG.internalToken;
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
