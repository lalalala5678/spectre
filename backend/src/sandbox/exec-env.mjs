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

// F4(部署审计四轮): 沙箱根默认跟随 SPECTRE_DATA_DIR——此前独立硬编码
// /var/lib/spectre, 设了 DATA_DIR 隔离的实例仍会挂载生产 workspace/skills。
export const SANDBOX_ROOT = process.env.SPECTRE_SANDBOX_ROOT
  ?? process.env.SPECTRE_DATA_DIR
  ?? '/var/lib/spectre';
export const HOST = {
  workspace: path.join(SANDBOX_ROOT, 'workspace'),
  skills: path.join(SANDBOX_ROOT, 'skills'),
  tools: path.join(SANDBOX_ROOT, 'tools'),
  uploads: path.join(SANDBOX_ROOT, 'uploads'),
};
export const CONTAINER = {
  workspace: '/workspace',
  skills: '/opt/skills',
  tools: '/opt/tools',
  uploads: '/opt/uploads',
};

const ok = value => ({ ok: true, value });
/** Generic Result error (shell paths — official ExecutionError codes). */
const err = error => ({ ok: false, error });
/** Map node fs errors onto the official FileError codes (the mutation
 *  queue, path utils etc. branch on `not_found`/`permission_denied`). */
const fsErr = e => {
  const code = e?.code ?? 'io_error';
  // CS2-#15: 'ENOTDIRDIR' 不是 Node 错误码(fs.constants 实证), 且
  // ENOTDIR 已映为 not_found——死分支删除, not_directory 映射不可达。
  const mapped = code === 'ENOENT' || code === 'ENOTDIR' ? 'not_found'
    : code === 'EACCES' || code === 'EPERM' ? 'permission_denied'
    : code === 'EISDIR' ? 'is_directory' : 'unknown';
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
  // r8-D2: 未映射路径一律 null——此前原样返回, 宿主任意绝对路径
  // (如 /var/lib/x)被当合法容器路径流转, 与 cwd/resolve 叠加后落
  // 双前缀位置(/var/lib/spectre/var/lib/x)。
  return null;
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
/** 自测-1(安全): 子进程环境白名单——平台凭据(LLM_API_KEY/INTERNAL_TOKEN/
 * SPECTRE_*)绝不进入 /proc/self/environ。仅透传跨平台工具链必需变量;
 * extraEnv 是调用方显式注入(沙箱 keyfiles 等), 恒保留。 */
const SAFE_ENV_KEYS = ['PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'USER', 'SHELL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
function sanitizedEnv(extraEnv) {
  const env = {};
  for (const k of SAFE_ENV_KEYS) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return Object.assign(env, extraEnv ?? {});
}

function spawnShell(argv, command, timeoutSec, cwdContainer, extraEnv) {
  // R5-F5: 超时杀宿主 docker exec 客户端不会终止容器内命令(attached
  // exec 不转发信号, 只产生 stdin EOF)。容器分支用 timeout(1) 包装,
  // 截止时刻在容器内执行——超时契约真正终止该次执行而非仅断视图。
  const argvv = argv.length
    ? [...argv, 'timeout', '-k', '2', String(timeoutSec || 86400), 'bash', '-c', command]
    : ['bash', '-c', command];  // r8-D5: -l 读 profile(line11 env 缺失噪声进 stderr)
  // Docker branch: `docker exec -w` already sets the CONTAINER cwd — the
  // host-side spawn cwd must merely EXIST. Passing the container path here
  // (e.g. /workspace/<ws>) made spawn die with ENOENT the moment the docker
  // driver became available (bash/nuclei/dig "all dead" during the SCUT
  // nday live run — surfaced 2026-09-12).
  const cwdHost = argv.length ? process.cwd()
    : (containerPathToHost(cwdContainer) ?? cwdContainer);
  // r12 建议: 后台形态命令(nohup/& 收尾/setsid/screen/tmux)提前返回——
  // 此前后台子进程持有 stdout fd, execFile 一直等到 300s 超时(r12 靶场
  // 重建实测"包装器挂起怪癖")。detached+ignore stdio 让父进程即时退出。
  const cmdStr = String(command);
  const isBg = /(^|\s)(nohup|setsid|screen|tmux)\b/.test(cmdStr)
    || /&\s*(#.*)?$/.test(cmdStr.trim()) || /\s&\s/.test(cmdStr);
  if (isBg) {
    try {
      // r14-①: 后台输出落盘可回读——外层重定向不影响命令内部显式重定向
      // (内部 > 优先生效, 外层仅兜底捕获未定向输出)。回执附日志路径。
      const bgLog = `/tmp/spectre-bg-${Date.now().toString(36)}.log`;
      const bg = spawn('bash', ['-c', `mkdir -p /tmp; ( ${cmdStr} ) > ${bgLog} 2>&1`], {
        detached: true, stdio: 'ignore',
        env: sanitizedEnv(extraEnv), cwd: cwdHost,
      });
      bg.unref();
      // FLv2: 与 spawnShell 正常 resolve 形状对齐({exitCode,text})——
      // 上版给 {ok,stdout} 被官方 bash 工具的 text.split 路径炸(undefined)
      return Promise.resolve({ exitCode: 0, text: `(后台任务已启动, 不等待输出。兜底输出日志: ${bgLog}(命令内部显式重定向优先); 稍后 bash 检查进度/标记文件)`, timedOut: false, background: true, bgLog });
    } catch (e) {
      return Promise.resolve({ exitCode: -1, text: String(e?.message ?? e), timedOut: false, spawnError: String(e?.message ?? e) });
    }
  }
  return new Promise(resolve => {
    const child = spawn(argvv[0], argvv.slice(1), {
      env: sanitizedEnv(extraEnv),
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
  const resolve = p => {
    const s = String(p ?? '');
    const host = containerPathToHost(s);
    return host ?? s;
  };
  /** E2/E2b 统一写策略: 映射层尊重挂载意图——未映射绝对路径拒写
   * (扩展到全部变更操作);skills 前缀拒写(容器 :ro 意图,宿主侧
   * 绕过=跨 agent 污染向量)。合法技能写入走 saveSkill。 */
  const denyMutate = p => {
    const s = String(p ?? '');
    if (path.isAbsolute(s) && containerPathToHost(s) === null) {
      return `路径 ${s} 不在容器映射表(/workspace,/opt/tools,/opt/skills)内——落宿主而 bash 看不见。改用 /workspace/<项目>/ 相对路径或 /opt/tools/。`;
    }
    const host = resolve(s);
    if (host === HOST.skills || host.startsWith(HOST.skills + path.sep)) {
      return `路径 ${s} 属 /opt/skills(只读挂载意图)——技能写入请用 configure_skill 工具或配置面板(带 frontmatter 校验),write 直写会绕过校验污染其它 agent。`;
    }
    return null;
  };
  const wrap = async fn => {
    try { return ok(await fn()); } catch (e) { return fsErr(e); }
  };
  return {
    cwd: cwdContainer,
    // F30-A: 返回容器视图路径——官方 write 拿 absolutePath 的结果原样传回
    // env.writeFile,若此处给宿主路径,守卫(按容器路径判定)会把相对路径
    // 解析结果当"未映射绝对路径"拦杀(weakcred 实战两轮谎报成功的根因)。
    absolutePath: async (p, _ctx) => wrap(async () => {
      const str = String(p ?? '');
      if (path.isAbsolute(str)) {
        // 已是容器路径(或宿主路径→转容器视图);未映射的保持原样由守卫拒
        const host = containerPathToHost(str);
        if (host) return str;
        const cont = hostPathToContainer(str);
        return cont ?? path.resolve(str);
      }
      return path.join(cwdContainer, str);
    }),
    joinPath: async (parts, _ctx) => wrap(async () => path.join(...parts)),
    readTextFile: async (p, _ctx) => wrap(async () =>
      await fsp.readFile(resolve(p), 'utf8')),
    readTextLines: async (p, opts, _ctx) => wrap(async () => {
      const max = opts?.maxLines ?? Infinity;
      const lines = [];
      const content = await fsp.readFile(resolve(p), 'utf8');
      for (const line of content.split('\n')) {
        lines.push(line);
        if (lines.length >= max) break;
      }
      return lines;
    }),
    readBinaryFile: async (p, _ctx) => wrap(async () =>
      new Uint8Array(await fsp.readFile(resolve(p)))),
    writeFile: async (p, content, _ctx) => {
      // F30-B: 拍平双层 Result——wrap(ok(inner)) 会把内层 {ok:false} 当
      // 成功值,pi 的 getOrThrow 不抛→官方工具谎报 Successfully wrote。
      const deny = denyMutate(p);
      if (deny) return err(Object.assign(new Error(deny), { code: 'permission_denied' }));
      try {
        await fsp.mkdir(path.dirname(resolve(p)), { recursive: true });
        await fsp.writeFile(resolve(p), content);
        return ok(undefined);
      } catch (e) { return err(e instanceof Error ? e : new Error(String(e))); }
    },
    appendFile: async (p, content, _ctx) => {
      const deny = denyMutate(p);
      if (deny) return err(Object.assign(new Error(deny), { code: 'permission_denied' }));
      try {
        await fsp.mkdir(path.dirname(resolve(p)), { recursive: true });
        await fsp.appendFile(resolve(p), content);
        return ok(undefined);
      } catch (e) { return err(e instanceof Error ? e : new Error(String(e))); }
    },
    renameFile: async (s, d, _ctx) => {
      const deny = denyMutate(s) ?? denyMutate(d);
      if (deny) return err(Object.assign(new Error(deny), { code: 'permission_denied' }));
      try {
        await fsp.rename(resolve(s), resolve(d));
        return ok(undefined);
      } catch (e) { return err(e instanceof Error ? e : new Error(String(e))); }
    },
    fileInfo: async (p, _ctx) => wrap(async () => {
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
    listDir: async (p, _ctx) => wrap(async () => {
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
    canonicalPath: async (p, _ctx) => wrap(async () =>
      await fsp.realpath(resolve(p))),
    exists: async (p, _ctx) => wrap(async () =>
      fs.existsSync(resolve(p))),
    createDir: async (p, opts, _ctx) => {
      const deny = denyMutate(p);
      if (deny) return err(Object.assign(new Error(deny), { code: 'permission_denied' }));
      try {
        await fsp.mkdir(resolve(p), { recursive: opts?.recursive !== false });
        return ok(undefined);
      } catch (e) { return err(e instanceof Error ? e : new Error(String(e))); }
    },
    cleanup: async _ctx => { /* host fs needs no cleanup */ },
  };
}

/** Local driver: rewrite container-style absolute paths inside bash
 *  commands to their host mounts — agents reason in CONTAINER paths
 *  (/workspace /opt/uploads …) regardless of the driver underneath. */
export function rewritePathsForLocal(command) {
  // r9-D2 真根修(幂等化): 宿主前缀(/var/lib/spectre/workspace/x)内含
  // 容器键子串(/workspace/), 此前被二次替换成 /var/lib/spectre/var/
  // lib/spectre/workspace/x——每执行一层加一层前缀(r9 铁证: echo 单
  // 前缀→回显双前缀, stat 双前缀→三前缀)。先把宿主前缀占位保护,
  // 再做容器→宿主替换, 最后还原——幂等。
  let out = command;
  const stash = [];
  for (const key of Object.keys(HOST)) {
    const ph = `\u0000SPH_${key}\u0000`;
    out = out.split(HOST[key]).join(ph);
    stash.push([ph, HOST[key]]);
  }
  for (const key of Object.keys(CONTAINER)) {
    const c = CONTAINER[key];
    const h = HOST[key];
    out = out.split(c + '/').join(h + '/');
    out = out.split(c + ' ').join(h + ' ');
    out = out.split(c + '\n').join(h + '\n');
    out = out.split(c + '"').join(h + '"');
    out = out.split(c + '\'').join(h + '\'');
  }
  for (const [ph, h] of stash) out = out.split(ph).join(h);
  return out;
}

/** Shared-tool PATH prefix — injected into EVERY bash invocation so
 *  /opt-tools installs are environment-level (公理二: CLI 全员共享).
 *  Prefix dirs: bin (binaries), npm-global/bin (npm -g target),
 *  py (pip --target scripts live under tools anyway). */
export function sharedToolPath() {
  return [
    `${CONTAINER.tools}/bin`,
    `${CONTAINER.tools}/npm-global/bin`,
  ].join(':');
}

/**
 * Build an ExecutionEnv for one project workspace.
 * @param {{driver: 'local'|'docker', container?: string}} cfg
 * @param {string} wsId project id — cwd = /workspace/<wsId>
 */
export function makeExecutionEnv(cfg, wsId) {
  const cwdContainer = `${CONTAINER.workspace}/${wsId}`;
  const fsEnv = makeFileSystem(cwdContainer);
  const toolPath = sharedToolPath();
  // NOTE: `$PATH` inside this template would reach the container as a
  // LITERAL (docker -e does not expand) — the container then had no bash
  // on PATH (exit 127, "bash not found"). Expand the HOST path list here
  // so the container PATH = shared-tool dirs + sane system defaults.
  // CS21-2: 第三处 'spectre-sandbox' 字面量回退删——现况调用面恒传
  // sandboxConfig()(死回退), 但'容器名单源'宣称不容字面量幸存; 缺
  // container 即 fail-fast(命名空间契约, 防隔离实例落生产容器)。
  if (cfg.driver === 'docker' && !cfg.container) {
    throw new Error('docker driver 需要 sandboxConfig().container(数据根命名空间容器名)');
  }
  const execArgv = cfg.driver === 'docker'
    ? ['docker', 'exec', '-w', cwdContainer,
      '-e', `PATH=${toolPath}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      cfg.container]
    : [];
  const shell = {
    exec: (command, options, _ctx) => {
      const runner = cfg.driver === 'docker'
        ? (cmd, timeout) => spawnShell(execArgv, cmd, timeout, cwdContainer)
        : (cmd, timeout) => spawnShell([], rewritePathsForLocal(cmd), timeout, cwdContainer,
          { PATH: `${containerPathToHost(toolPath.split(':')[0])
            ?? toolPath.split(':')[0]}:${process.env.PATH}` });
      return runShell(runner, command, { cwd: cwdContainer, ...options });
    },
    cleanup: async _ctx => {},
  };
  return { ...fsEnv, ...shell };
}

/** Ensure a project workspace exists (host side of the mount; sync 变体——
 * CS6-F2: 异步版零引用已删, 全仓唯一消费点是会话创建的同步装配). */
export function ensureWorkspaceSync(wsId) {
  const dir = path.join(HOST.workspace, wsId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
