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
