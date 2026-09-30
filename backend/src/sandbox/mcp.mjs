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
  mcpConfigSuspect = false;
  return servers;
}

export async function saveMcpConfig(next) {
  if (mcpConfigSuspect) {
    throw new Error('mcp-servers.json 最近一次读取失败,拒绝写回以防清空配置;请先排查文件后重试');
  }
  servers = next;
  await fsp.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return servers;
}

/** R22-F2: 互斥读改写——五写入方(routes POST/DELETE/agent-settings 同步/
 * tooling configure/remove)此前各自裸 load→filter→save, 并发窗口内后写
 * 者以旧快照整文件覆盖, 静默丢整条 server 配置(R17-F1 同款)。
 * 锁内 load→fn(list)→save, 保留 corrupt-latch 语义。 */
let mcpMutateChain = Promise.resolve();
export function mutateMcpConfig(fn) {
  const run = mcpMutateChain.then(async () => {
    const list = await loadMcpConfig();
    const next = await fn(list);
    if (next !== undefined && next !== null) await saveMcpConfig(next);
    return next;
  });
  // 链上错误不阻断后续调用
  mcpMutateChain = run.catch(() => {});
  return run;
}

export function mcpServersFor(agentKey) {
  return servers.filter(s => (s.agents ?? []).includes(agentKey)
    && s.enabled !== false);
}

// ------------------------------------------------------- JSON-RPC stdio

/** Keep the HEAD of stderr (the `Error: ...` first line lives there —
 *  a tail-only clip once amputated exactly that line; review round 1). */
function clipStderr(t) {
  if (!t) return '';
  const flat = String(t).replace(/\s+$/g, '');
  return flat.length <= 600 ? flat
    : flat.slice(0, 400) + '\n…(中段省略)…\n' + flat.slice(-200);
}

class StdioRpc {
  constructor(argv, env, opts = {}) {
    this.argv = argv;
    this.env = env ?? {};
    this.container = opts.container ?? null;  // R5-F1: 远程 kill 目标
    this.remotePid = null;
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
    // spawn failures (ENOENT etc) emit 'error', NOT 'close' — an
    // unhandled 'error' once crashed the whole runtime (round-2 review
    // hit it with a nonexistent command). Drain it into the same
    // pending-rejection path as 'close'.
    this.child.on('error', e => {
      this.spawnError = `spawn ${this.argv[0]}: ${e.message}`;
      for (const p of this.pending.values()) {
        p.reject(new Error(`${this.spawnError} ${clipStderr(this.stderr)}`));
      }
      this.pending.clear();
    });
    this.child.on('close', code => {
      for (const p of this.pending.values()) {
        p.reject(new Error(`MCP server exited (code=${code}):`
          + ` ${clipStderr(this.stderr)}`));
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
      // R5-F1: PID-echo 协议——sh -c 'echo $$; exec' 的首行是容器侧
      // PID(非 JSON), JSON 解析本就忽略; 捕获供 close() 远程 kill。
      if (this.remotePid === null && /^\d+$/.test(line)) {
        this.remotePid = Number(line);
        continue;
      }
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message ?? 'MCP error'));
          } else {
            resolve(msg.result);
          }
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
      // hard timeout: a live-but-silent server must fail the call, not
      // hang the agent's turn forever (no timeout = permanent busy)
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP call ${method} timed out (120s)`));
      }, 120_000);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  close() {
    // R5-F1: 先杀容器内真实进程(attached docker exec 不转发信号,
    // 只杀宿主客户端会泄漏容器侧进程)。fire-and-forget: TERM→1s→KILL。
    if (this.container && this.remotePid) {
      const kill = sig => { try { spawn('docker', ['exec', this.container, 'kill', `-${sig}`, String(this.remotePid)], { stdio: 'ignore' }); } catch { /* best effort */ } };
      kill('TERM');
      setTimeout(() => kill('KILL'), 1000).unref?.();
    }
    try { this.child.kill(); } catch { /* already gone */ }
  }
}

/** stdio channel via sandbox driver: docker exec -i keeps stdin/stdout
 *  wired straight into the container-side process. */
async function connectStdio(server) {
  if (server.where === 'sandbox') {
    // docker exec -i <container> <command...> — streams over the driver.
    // R5-F1: attached docker exec 不转发信号——杀宿主客户端只产生
    // stdin EOF, 容器内进程存活(实测 sleep 600 残留)。sh -c 先回显
    // 容器侧 PID(首行), close() 时 docker exec kill 该 PID。
    const argv = ['docker', 'exec', '-i',
      server.container ?? 'spectre-sandbox', 'sh', '-c',
      'echo $$; exec "$@"', '--', ...server.command];
    const rpc = new StdioRpc(argv, server.env, {
      container: server.container ?? 'spectre-sandbox' });
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
  const killAll = () => { for (const r of exitTied) { try { r.close(); } catch { /* best-effort: 进程退出期 close 幂等 */ } } };
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
    let res;
    try {
      res = await fetch(this.url, {
        signal: AbortSignal.timeout(30_000),
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
    } catch (e) {
      const c = e?.cause ? ` (cause: ${e.cause.code ?? e.cause.message ?? e.cause})` : '';
      throw new Error(`MCP HTTP 连接失败:${e.message}${c} — url=${this.url}`);
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    const ctype = res.headers.get('content-type') ?? '';
    if (ctype.includes('text/event-stream')) {
      // streamable-HTTP SSE response: take the first JSON data frame
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      // Parse COMPLETE frames only: a non-greedy {} match once truncated
      // JSON at the first inner '}' and mis-parsed notification frames as
      // the response. Frames are newline-delimited `data: {...}` lines.
      const tryParse = text => {
        for (const line of text.split('\n')) {
          const t = line.replace(/^data:\s*/, '').trim();
          if (!t.startsWith('{')) continue;
          try {
            const msg = JSON.parse(t);
            // only OUR response resolves; notifications/logging stream by
            if (msg.id === id && (msg.result !== undefined || msg.error)) return msg;
          } catch { /* partial frame — keep buffering */ }
        }
        return null;
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const msg = tryParse(buf);
        if (msg) {
          reader.cancel().catch(() => {});
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

/** Corrupt-read latch: a failed load must NEVER be followed by a save
 *  (saving [] over a transiently unreadable file once wiped every MCP
 *  config, memory AND disk). Cleared only by a successful load. */
let mcpConfigSuspect = false;
const connecting = new Map(); // server name → in-flight connect promise

async function connection(server) {
  if (running.has(server.name)) return running.get(server.name);
  // single-flight: concurrent first-connects once double-spawned child
  // processes and the last writer orphaned the rest
  if (connecting.has(server.name)) return connecting.get(server.name);
  const p = (async () => {
    const rpc = server.transport === 'http'
      ? await new HttpRpc(server.url, server.headers).start()
      : await connectStdio(server);
    // initialize WITH a timeout — a hung server must fail fast, not
    // hang rebuildMounts (and every route that awaits it) forever
    await withTimeout(rpc.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'spectre', version: '1.0.0' },
    }), 15_000, 'MCP initialize timeout');
    rpc.call('notifications/initialized', {}).catch(() => {});
    running.set(server.name, rpc);
    return rpc;
  })().finally(() => connecting.delete(server.name));
  connecting.set(server.name, p);
  return p;
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); });
  });
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
  for (const n of running.keys()) {
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

/** Connectivity test used by the console MCP page. Bounded wrapper: a
 *  hung server must fail fast AND its spawned child must be reaped — the
 *  old race leaked the stdio process on timeout. */
export async function testMcpServer(server) {
  try {
    return await Promise.race([
      _testMcpServer(server),
      new Promise(resolve => setTimeout(() => {
        const c = testConns.get(server.name);
        if (c) { try { c.close(); } catch { /* best-effort: 已断开 */ } testConns.delete(server.name); }
        resolve({ ok: false, error: 'timeout (10s)' });
      }, 10000)),
    ]);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const testConns = new Map(); // server.name → rpc (for timeout reaping)

async function _testMcpServer(server) {
  let rpc = null;
  try {
    rpc = server.transport === 'http'
      ? await new HttpRpc(server.url, server.headers).start()
      : await connectStdio(server);
    testConns.set(server.name, rpc);
    const init = await rpc.call('initialize', {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'spectre', version: '1.0.0' },
    });
    const { tools } = await rpc.call('tools/list', {});
    rpc.close();
    testConns.delete(server.name);
    return { ok: true, serverName: init?.serverInfo?.name ?? '?',
      protocol: init?.protocolVersion ?? '?',
      tools: (tools ?? []).map(t => t.name) };
  } catch (err) {
    if (rpc) { try { rpc.close(); } catch { /* best-effort: 服务器已退出 */ } }
    testConns.delete(server.name);
    return { ok: false, error: err.message };
  }
}
