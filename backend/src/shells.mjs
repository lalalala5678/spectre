/**
 * Shell registry — C2 implant handles as first-class citizens.
 *
 * A "shell" = an operational channel to a compromised host produced by the
 * C2 agent (implant QA-passed + acceptance-stamped). Registered here with
 * its transport; the operator console and stage agents (persistence/postex)
 * execute through it — one transport, three consumers:
 *   1. Frontend terminal (operator types commands, SSH-like)
 *   2. `shell` agent tool (exec/read_file handed to persistence/postex)
 *   3. C2 agent itself (delivery bookkeeping)
 *
 * Authorization: every shell is bound to an authorized target + exercise
 * window (HVV scope file). exec() refuses outside scope — same hard gate
 * as c2-qa.py (exit discipline) but enforced server-side.
 *
 * Transports: 'local' (benchmark/dev: command runs in a designated sandbox
 * box) — real implant transports (jmreport/http channel) plug in later via
 * the same interface.
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';

/** shells by id — process-lifetime registry (audit trail lives on the bus). */
const shells = new Map();

const MAX_OUT = 64 * 1024;

export function createShellRegistry({ bus, wal, listScope } = {}) {
  const audit = (kind, data) => {
    try { bus?.emit?.('shell-event', { kind, at: new Date().toISOString(), ...data }); } catch { /* bus optional */ }
  };

  function gate(shell) {
    // Server-side authorization: exercise window + target binding.
    const sc = listScope?.() ?? null;
    if (!sc) return { ok: false, error: 'scope 不可读:授权门配置缺失' };
    const now = new Date().toISOString().slice(0, 19) + 'Z';
    const inWindow = sc.window && sc.window.start <= now && now <= sc.window.end;
    const inTargets = Array.isArray(sc.targets) && sc.targets.includes(shell.target);
    if (!sc.targets?.length || !inWindow) return { ok: false, error: '授权门:窗口外或无目标(拒绝)' };
    if (!inTargets) return { ok: false, error: `授权门:目标 ${shell.target} 不在清单(拒绝)` };
    if (shell.expiresAt && now > shell.expiresAt) return { ok: false, error: 'shell 已过期(一次性纪律)' };
    return { ok: true };
  }

  function register({ name, target, transport = 'local', transportRef = '', note = '', createdBy = 'operator', ttlHours = 24 }) {
    const id = 'sh-' + randomUUID().slice(0, 8);
    const sh = {
      id, name: name || id, target, transport, transportRef, note,
      createdBy, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlHours * 3600e3).toISOString(),
      cmdCount: 0, lastActiveAt: null, status: 'active',
      tasks: [],          // tasking history (Mythic): {n, command, code, ms, at}
      host: null, user: null, os: null,  // auto-fingerprint (Sliver session meta)
    };
    shells.set(id, sh);
    audit('shell-register', { id, target, transport, createdBy });
    return sh;
  }

  function list() { return [...shells.values()]; }

  function get(id) { return shells.get(id) ?? null; }

  function close(id) {
    const sh = shells.get(id);
    if (!sh) return { ok: false, error: 'shell 不存在' };
    sh.status = 'closed';
    audit('shell-close', { id });
    return { ok: true };
  }

  /**
   * Execute one command over the shell. Transport 'local' = run inside the
   * configured exec box (docker container) — benchmark-grade fidelity.
   * Returns { ok, stdout, stderr, code, ms }.
   */
  async function exec(id, command, { timeoutMs = 30_000, box = null } = {}) {
    const sh = shells.get(id);
    if (!sh) return { ok: false, error: 'shell 不存在' };
    if (sh.status !== 'active') return { ok: false, error: `shell 状态 ${sh.status}` };
    const g = gate(sh);
    if (!g.ok) return { ok: false, error: g.error };
    const t0 = Date.now();
    let stdout = '', stderr = '', code = 0;
    try {
      if (sh.transport === 'local') {
        // transportRef binds the shell to ONE exec box — commands land in
        // the compromised box, never the runtime host. Format "container"
        // (default user) or "container:user" (low-priv web compromise).
        const ref = sh.transportRef || 'spectre-sandbox';
        const [cbox, cuser] = ref.includes(':') ? ref.split(':') : [ref, null];
        const argv = cuser
          ? ['exec', '-u', cuser, cbox, 'bash', '-lc', command]
          : ['exec', cbox, 'bash', '-lc', command];
        const res = await new Promise((resolve) => {
          execFile('docker', argv, { timeout: timeoutMs, maxBuffer: MAX_OUT }, (err, so, se) =>
            resolve({ err, so: String(so ?? ''), se: String(se ?? '') }));
        });
        stdout = res.so; stderr = res.se;
        code = res.err ? (res.err.code ?? 1) : 0;
        if (res.err && res.err.killed) stderr += '\n[timeout]';
      } else {
        return { ok: false, error: `transport ${sh.transport} 未接入(真实植入通道后续挂)` };
      }
    } catch (e) {
      return { ok: false, error: 'exec 异常: ' + e.message };
    }
    sh.cmdCount += 1; sh.lastActiveAt = new Date().toISOString();
    const task = { n: sh.cmdCount, command: command.slice(0, 500), code, ms: Date.now() - t0, at: sh.lastActiveAt };
    sh.tasks.push(task);
    if (sh.tasks.length > 100) sh.tasks.splice(0, sh.tasks.length - 100);
    audit('shell-exec', { id, target: sh.target, cmd: command.slice(0, 120), code, ms: task.ms });
    return { ok: code === 0, stdout: stdout.slice(0, MAX_OUT), stderr: stderr.slice(0, MAX_OUT), code, ms: task.ms, task };
  }

  /** Auto-fingerprint the host once (whoami/uname) — Sliver-style session meta. */
  async function fingerprint(id) {
    const sh = shells.get(id);
    if (!sh || sh.host) return sh;
    const u = await exec(id, 'id -un 2>/dev/null; uname -a 2>/dev/null | head -1');
    if (u.ok) {
      const [user, ...rest] = String(u.stdout).split('\n');
      sh.user = (user || '').trim() || null;
      sh.os = rest.join(' ').trim() || null;
      sh.host = sh.os ? String(sh.os).split(' ')[1] : null;
    }
    return sh;
  }

  /** Convenience: read one file through the shell (cat), for agent tool. */
  async function readFile(id, path) {
    const r = await exec(id, `cat -- ${JSON.stringify(path)} 2>&1 | head -c 65536`);
    return r;
  }

  return { register, list, get, close, exec, readFile, gate, fingerprint };
}
