/**
 * MCP bridge — per-agent mounted MCP servers, two transports:
 *
 *   stdio : local or sandbox-side process (docker exec -i → stdio 直连).
 *           `where: 'sandbox' | 'host'` decides the spawn channel.
 *   http  : REMOTE servers the user stands up on other machines — the
 *           console takes name/url/headers and agents connect directly
 *           (streamable-HTTP JSON-RPC; session id honored when present).
 *
 * Minimal client, zero new dependencies: initialize / tools/list /
 * tools/call are the entire surface the bridge needs. Tools are merged
 * into the bare-Agent tool matrix at session creation (snapshot).
 *
 * Config storage is a plain JSON file + management API — the future
 * "MCP configuration agent" will edit the same store through the API.
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { Type } from '@earendil-works/pi-ai';

import { SANDBOX_ROOT } from './exec-env.mjs';

const CONFIG_PATH = path.join(SANDBOX_ROOT, 'mcp-servers.json');

// ---------------------------------------------------------------- config

let servers = [];

export async function loadMcpConfig() {
  try {
    servers = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
  } catch {
    servers = [];
  }
  return servers;
}

export async function saveMcpConfig(next) {
  servers = next;
  await fsp.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return servers;
}

export function mcpServersFor(agentKey) {
  return servers.filter(s => (s.agents ?? []).includes(agentKey)
    && s.enabled !== false);
}

// ------------------------------------------------------- JSON-RPC stdio

class StdioRpc {
  constructor(argv, env) {
    this.argv = argv;
    this.env = env ?? {};
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
  }
  async start() {
    this.child = spawn(this.argv[0], this.argv.slice(1), {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', d => this._onData(d));
    this.child.stderr.on('data', d => { this.stderr = (this.stderr ?? '') + d; });
    this.child.on('close', () => {
      for (const p of this.pending.values()) {
        p.reject(new Error(`MCP server exited: ${this.stderr?.slice(-300) ?? ''}`));
      }
      this.pending.clear();
    });
    return this;
  }
  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(msg.error.message ?? 'MCP error'))
            : resolve(msg.result);
        }
      } catch { /* non-JSON line (server logs) — ignore */ }
    }
  }
  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin?.writable) {
        reject(new Error('MCP server process not running'));
        return;
      }
      this.pending.set(id, { resolve, reject });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  close() {
    try { this.child.kill(); } catch { /* already gone */ }
  }
}

/** stdio channel via sandbox driver: docker exec -i keeps stdin/stdout
 *  wired straight into the container-side process. */
async function connectStdio(server) {
  if (server.where === 'sandbox') {
    // docker exec -i <container> <command...> — streams over the driver
    const { spawn: sp } = await import('node:child_process');
    const argv = ['docker', 'exec', '-i',
      server.container ?? 'spectre-sandbox', ...server.command];
    const rpc = new StdioRpc(argv, server.env);
    const conn = await rpc.start();
    tieToParentExit(conn);
    return conn;
  }
  const rpc = new StdioRpc(server.command, server.env);
  const conn = await rpc.start();
  tieToParentExit(conn);
  return conn;
}

/** Orphan prevention: a stdio child survives its parent by default
 *  (reparented to init). 'exit' fires only on normal shutdown — node
 *  terminates on SIGTERM/SIGINT WITHOUT running exit handlers, so both
 *  paths are covered explicitly (SIGKILL is systemd's cgroup job). */
const exitTied = new Set();
let handlersArmed = false;
function tieToParentExit(rpc) {
  exitTied.add(rpc);
  if (handlersArmed) return;
  handlersArmed = true;
  const killAll = () => { for (const r of exitTied) { try { r.close(); } catch {} } };
  process.once('exit', killAll);
  process.once('SIGTERM', () => { killAll(); process.exit(0); });
  process.once('SIGINT', () => { killAll(); process.exit(0); });
}

// -------------------------------------------------- JSON-RPC over HTTP

class HttpRpc {
  constructor(url, headers) {
    this.url = url;
    this.headers = headers ?? {};
    this.nextId = 1;
    this.sessionId = null;
  }
  async start() { return this; }
  async call(method, params) {
    const id = this.nextId++;
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-06-18',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    const ctype = res.headers.get('content-type') ?? '';
    if (ctype.includes('text/event-stream')) {
      // streamable-HTTP SSE response: take the first JSON data frame
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const m = buf.match(/data:\s*(\{[\s\S]*?\})\s*\n/);
        if (m) {
          reader.cancel().catch(() => {});
          const msg = JSON.parse(m[1]);
          if (msg.error) throw new Error(msg.error.message ?? 'MCP error');
          return msg.result;
        }
      }
      throw new Error('MCP SSE stream ended without a result');
    }
    const msg = await res.json();
    if (msg.error) throw new Error(msg.error.message ?? 'MCP error');
    return msg.result;
  }
  close() { /* stateless; nothing to release */ }
}

// ------------------------------------------------------------- bridge

const running = new Map(); // server name → rpc conn

async function connection(server) {
  if (running.has(server.name)) return running.get(server.name);
  const rpc = server.transport === 'http'
    ? await new HttpRpc(server.url, server.headers).start()
    : await connectStdio(server);
  await rpc.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'spectre', version: '1.0.0' },
  });
  rpc.call('notifications/initialized', {}).catch(() => {});
  running.set(server.name, rpc);
  return rpc;
}

/** Close and drop a pooled connection — the config was removed or
 *  changed, so the child process (stdio) must not outlive it. */
export function closeMcpConnection(name) {
  const rpc = running.get(name);
  if (!rpc) return false;
  running.delete(name);
  try { rpc.close(); } catch { /* already gone */ }
  return true;
}

/** Reconcile the pool against the config: close connections whose
 *  server no longer exists (called after every rebuildMounts). */
export async function purgeStaleMcpConnections() {
  const names = new Set((await loadMcpConfig()).map(s => s.name));
  const closed = [];
  for (const n of [...running.keys()]) {
    if (!names.has(n) && closeMcpConnection(n)) closed.push(n);
  }
  return closed;
}

/** pi Tool wrappers for one MCP server's tools (schema from listTools). */
export async function mcpToolsForServer(server) {
  try {
    const rpc = await connection(server);
    const { tools } = await rpc.call('tools/list', {});
    return (tools ?? []).map(t => ({
      name: `mcp_${server.name}_${t.name}`,
      label: `${server.name}:${t.name}`,
      description: (t.description ?? `MCP tool ${t.name} from ${server.name}`)
        + ' [MCP]',
      executionMode: 'sequential',
      parameters: t.inputSchema ?? Type.Object({}),
      execute: async (_toolCallId, params) => {
        const result = await rpc.call('tools/call', {
          name: t.name, arguments: params,
        });
        const text = (result?.content ?? [])
          .filter(c => c.type === 'text').map(c => c.text).join('\n');
        return {
          content: [{ type: 'text', text: text || '(空输出)' }],
          details: { isError: result?.isError ?? false },
        };
      },
    }));
  } catch (err) {
    console.warn(`[mcp] ${server.name} unavailable: ${err.message}`);
    return [];
  }
}

/** All MCP tools mounted for one agent (session-creation snapshot). */
export async function mcpToolsFor(agentKey) {
  const lists = await Promise.all(mcpServersFor(agentKey).map(mcpToolsForServer));
  return lists.flat();
}

/** Connectivity test used by the console MCP page. */
/** Bounded wrapper: a hung server must fail fast, never stall the
 *  calling agent's turn. */
export async function testMcpServer(server) {
  try {
    return await Promise.race([
      _testMcpServer(server),
      new Promise(resolve => setTimeout(() =>
        resolve({ ok: false, error: 'timeout (10s)' }), 10000)),
    ]);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function _testMcpServer(server) {
  try {
    const rpc = server.transport === 'http'
      ? await new HttpRpc(server.url, server.headers).start()
      : await connectStdio(server);
    const init = await rpc.call('initialize', {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'spectre', version: '1.0.0' },
    });
    const { tools } = await rpc.call('tools/list', {});
    rpc.close();
    return { ok: true, serverName: init?.serverInfo?.name ?? '?',
      tools: (tools ?? []).map(t => t.name) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
