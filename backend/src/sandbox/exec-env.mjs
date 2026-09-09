/**
 * ExecutionEnv drivers — implementations of pi-agent-core's official
 * ExecutionEnv interface (FileSystem + Shell). The official bash/read/
 * write/edit tool factories run ON TOP of these, so sandboxing the env
 * sandboxes every official tool.
 *
 * Drivers:
 *   local  — direct host execution (zero-dependency fallback / trusted envs)
 *   docker — one long-lived container; project workspaces, skills and
 *            tools are bind-mounted host directories (shared CLI layer,
 *            per-project working dirs, cross-project readable by design)
 *
 * Path mapping (docker): container /workspace, /opt/skills, /opt/tools
 * map to host SANDBOX_ROOT/{workspace,skills,tools}. FileSystem methods
 * operate on the HOST side of the mounts (fast, no exec round-trip);
 * Shell.exec runs inside the sandbox via the driver's exec channel.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

/** Official context constant — harness helpers accept it directly. */
export const PI_CONTEXT = BACKGROUND_CONTEXT;

export const SANDBOX_ROOT = process.env.SPECTRE_SANDBOX_ROOT
  ?? '/var/lib/spectre';
export const HOST = {
  workspace: path.join(SANDBOX_ROOT, 'workspace'),
  skills: path.join(SANDBOX_ROOT, 'skills'),
  tools: path.join(SANDBOX_ROOT, 'tools'),
};
export const CONTAINER = {
  workspace: '/workspace',
  skills: '/opt/skills',
  tools: '/opt/tools',
};

const ok = value => ({ ok: true, value });
/** Generic Result error (shell paths — official ExecutionError codes). */
const err = error => ({ ok: false, error });
/** Map node fs errors onto the official FileError codes (the mutation
 *  queue, path utils etc. branch on `not_found`/`permission_denied`). */
const fsErr = e => {
  const code = e?.code ?? 'io_error';
  const mapped = code === 'ENOENT' || code === 'ENOTDIR' ? 'not_found'
    : code === 'EACCES' || code === 'EPERM' ? 'permission_denied'
    : code === 'EISDIR' ? 'is_directory'
    : code === 'ENOTDIRDIR' ? 'not_directory' : 'unknown';
  return { ok: false, error: { code: mapped, message: String(e?.message ?? code) } };
};

/** Container path → host path (bind-mount mapping, keyed by the SAME
 *  mount name in CONTAINER/HOST); null when unmapped. */
export function containerPathToHost(p) {
  for (const key of Object.keys(CONTAINER)) {
    const c = CONTAINER[key];   // container-side prefix
    const h = HOST[key];        // host-side prefix
    if (p === c) return h;
    if (p.startsWith(c + '/')) return path.join(h, p.slice(c.length + 1));
  }
  return null;
}

/** Host path → container path (inverse mapping). */
export function hostPathToContainer(p) {
  for (const key of Object.keys(CONTAINER)) {
    const c = CONTAINER[key];
    const h = HOST[key];
    if (p === h) return c;
    if (p.startsWith(h + path.sep)) {
      return c + '/' + p.slice(h.length + 1);
    }
  }
  return p;
}

/**
 * Shared bounded-capture semantics per the official ShellExecOptions
 * contract: output is tail-retained up to limits; the FULL output spills
 * to a file when truncated (official bash tool surfaces the path).
 */
async function runShell(runner, command, options = {}) {
  const limits = options.capture?.limits
    ?? { maxBytes: 256 * 1024, maxLines: 2000, retain: 'tail' };
  const t0 = Date.now();
  const { exitCode, text, timedOut, spawnError } = await runner(command,
    options.timeout);
  if (spawnError) return err({ code: 'spawn_failed', message: spawnError });
  let truncatedBy = null;
  let fullOutputPath;
  let view = text;
  const totalLines = view.split('\n').length;
  const totalBytes = Buffer.byteLength(view);
  if (totalLines > limits.maxLines) {
    view = view.split('\n').slice(-limits.maxLines).join('\n');
    truncatedBy = 'lines';
  }
  if (Buffer.byteLength(view) > limits.maxBytes) {
    view = Buffer.from(view, 'utf8')
      .subarray(-limits.maxBytes).toString('utf8');
    truncatedBy = truncatedBy ?? 'bytes';
  }
  const truncated = truncatedBy !== null;
  if (truncated && options.capture?.spill !== false && text.length > view.length) {
    try {
      fullOutputPath = `spectre-output-${Date.now().toString(36)}.log`;
      const spillDir = options.cwd
        ? containerPathToHost(options.cwd) ?? HOST.workspace
        : HOST.workspace;
      await fsp.mkdir(spillDir, { recursive: true });
      await fsp.writeFile(path.join(spillDir, fullOutputPath), text, 'utf8');
    } catch { /* spill is best-effort */ }
  }
  // Official ShellOutputView shape: FLAT (metadata fields at the top
  // level next to text — the bash tool reads view.truncation.truncated).
  options.onUpdate?.({
    kind: 'replace',
    output: {
      text: view,
      truncation: {
        content: view, truncated, truncatedBy,
        totalLines, totalBytes,
      },
      spillPath: fullOutputPath,
    },
  }, PI_CONTEXT);
  if (timedOut) {
    return err({ code: 'timeout', message: `timed out after ${options.timeout}s` });
  }
  // Official ShellExecResult + ShellOutputMetadata: the bash tool reads
  // result.value.truncation.{truncated,outputLines,outputBytes,…}.
  const outLines = view.split('\n');
  return ok({
    exitCode,
    durationMs: Date.now() - t0,
    truncation: {
      content: view, truncated, truncatedBy,
      totalLines, totalBytes,
      outputLines: outLines.length,
      outputBytes: Buffer.byteLength(view),
      lastLinePartial: truncatedBy === 'bytes'
        && !text.endsWith('\n'),
      firstLineExceedsLimit: false,
    },
    spillPath: fullOutputPath,
  });
}

/** Spawn helper: argv non-empty = prefixed channel (docker exec …);
 *  argv empty = plain local bash -c with the HOST-mapped cwd (container
 *  paths only exist inside the sandbox for the docker driver).
 *  Merged stdout/stderr capture. */
function spawnShell(argv, command, timeoutSec, cwdContainer) {
  const argvv = argv.length ? [...argv, 'bash', '-c', command]
    : ['bash', '-lc', command];
  const cwdHost = argv.length ? cwdContainer
    : (containerPathToHost(cwdContainer) ?? cwdContainer);
  return new Promise(resolve => {
    const child = spawn(argvv[0], argvv.slice(1), {
      env: { ...process.env },
      cwd: cwdHost,
    });
    let text = '';
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      resolve(result);
    };
    if (timeoutSec) {
      const ms = Math.min(timeoutSec * 1000, 2 ** 31 - 1);
      setTimeout(() => {
        child.kill('SIGKILL');
        finish({ exitCode: 124, text, timedOut: true });
      }, ms).unref?.();
    }
    child.stdout.on('data', d => { text += d; });
    child.stderr.on('data', d => { text += d; });
    child.on('error', e => finish({ exitCode: -1, text, spawnError: e.message }));
    child.on('close', code => finish({ exitCode: code ?? -1, text, timedOut: false }));
  });
}

/**
 * FileSystem implemented on the HOST side of the bind mounts — direct
 * node:fs calls, no exec round-trip. Container paths are mapped; host
 * paths (local driver) pass through.
 */
function makeFileSystem(cwdContainer) {
  const cwdHost = containerPathToHost(cwdContainer) ?? cwdContainer;
  const resolve = p => {
    const s = String(p ?? '');
    const host = containerPathToHost(s);
    return host ?? s;
  };
  /** Relative paths resolve against the SESSION's project cwd (mapped to
   *  its host path), never the runtime process cwd. */
  const resolveFull = p => {
    const s = String(p ?? '');
    return path.isAbsolute(s) ? resolve(s)
      : path.join(cwdHost, s);
  };
  const wrap = async fn => {
    try { return ok(await fn()); } catch (e) { return fsErr(e); }
  };
  return {
    cwd: cwdContainer,
    absolutePath: async (p, ctx) => wrap(async () => path.resolve(resolveFull(p))),
    joinPath: async (parts, ctx) => wrap(async () => path.join(...parts)),
    readTextFile: async (p, ctx) => wrap(async () =>
      await fsp.readFile(resolve(p), 'utf8')),
    readTextLines: async (p, opts, ctx) => wrap(async () => {
      const max = opts?.maxLines ?? Infinity;
      const lines = [];
      const content = await fsp.readFile(resolve(p), 'utf8');
      for (const line of content.split('\n')) {
        lines.push(line);
        if (lines.length >= max) break;
      }
      return lines;
    }),
    readBinaryFile: async (p, ctx) => wrap(async () =>
      new Uint8Array(await fsp.readFile(resolve(p)))),
    writeFile: async (p, content, ctx) => wrap(async () => {
      await fsp.mkdir(path.dirname(resolve(p)), { recursive: true });
      await fsp.writeFile(resolve(p), content);
    }),
    appendFile: async (p, content, ctx) => wrap(async () => {
      await fsp.mkdir(path.dirname(resolve(p)), { recursive: true });
      await fsp.appendFile(resolve(p), content);
    }),
    renameFile: async (s, d, ctx) => wrap(async () =>
      await fsp.rename(resolve(s), resolve(d))),
    fileInfo: async (p, ctx) => wrap(async () => {
      const host = resolve(p);
      const st = await fsp.lstat(host);
      return {
        name: path.basename(host),
        path: p,
        kind: st.isFile() ? 'file' : st.isDirectory() ? 'directory' : 'other',
        isFile: st.isFile(), isDirectory: st.isDirectory(),
        size: st.size, mtimeMs: st.mtimeMs,
      };
    }),
    listDir: async (p, ctx) => wrap(async () => {
      const entries = await fsp.readdir(resolve(p), { withFileTypes: true });
      return Promise.all(entries.map(async e => {
        const st = await fsp.lstat(path.join(resolve(p), e.name)).catch(() => null);
        return {
          name: e.name,
          path: p === '/' ? `/${e.name}` : `${p}/${e.name}`,
          kind: e.isFile() ? 'file' : e.isDirectory() ? 'directory' : 'other',
          isFile: e.isFile(), isDirectory: e.isDirectory(),
          size: st?.size ?? 0,
          mtimeMs: st?.mtimeMs ?? 0,
        };
      }));
    }),
    canonicalPath: async (p, ctx) => wrap(async () =>
      await fsp.realpath(resolve(p))),
    exists: async (p, ctx) => wrap(async () =>
      fs.existsSync(resolve(p))),
    createDir: async (p, opts, ctx) => wrap(async () =>
      await fsp.mkdir(resolve(p), { recursive: opts?.recursive !== false })),
    cleanup: async ctx => { /* host fs needs no cleanup */ },
  };
}

/**
 * Build an ExecutionEnv for one project workspace.
 * @param {{driver: 'local'|'docker', container?: string}} cfg
 * @param {string} wsId project id — cwd = /workspace/<wsId>
 */
export function makeExecutionEnv(cfg, wsId) {
  const cwdContainer = `${CONTAINER.workspace}/${wsId}`;
  const fsEnv = makeFileSystem(cwdContainer);
  const execArgv = cfg.driver === 'docker'
    ? ['docker', 'exec', '-w', cwdContainer, cfg.container ?? 'spectre-sandbox']
    : [];
  const shell = {
    exec: (command, options, ctx) => {
      const runner = cfg.driver === 'docker'
        ? (cmd, timeout) => spawnShell(execArgv, cmd, timeout, cwdContainer)
        : (cmd, timeout) => spawnShell([], cmd, timeout, cwdContainer);
      return runShell(runner, command, { cwd: cwdContainer, ...options });
    },
    cleanup: async ctx => {},
  };
  return { ...fsEnv, ...shell };
}

/** Ensure a project workspace exists (host side of the mount). */
export async function ensureWorkspace(wsId) {
  const dir = path.join(HOST.workspace, wsId);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** Sync variant for session-creation assembly (mkdir is cheap). */
export function ensureWorkspaceSync(wsId) {
  const dir = path.join(HOST.workspace, wsId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
