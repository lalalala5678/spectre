/**
 * Sandbox lifecycle + shared CLI layer + the mount registry
 * (sandbox driver settings). One LONG-LIVED container by design: CLI
 * tools are installed once and shared by every agent of every project;
 * project isolation is directory-level (cross-project reads are an
 * intentional feature).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { HOST } from './exec-env.mjs';

const REGISTRY_PATH = path.join(HOST.workspace, '..', 'sandbox-config.json');

// ------------------------------------------------------------- registry

// P0-B(五审): 容器名按数据目录命名空间化——隔离实例(SPECTRE_DATA_DIR
// 非默认)此前静默接管生产容器 spectre-sandbox(命令执行落生产挂载)。
// 默认数据目录保持原名, 现役容器/私架单元引用零影响。
const dataDir = process.env.SPECTRE_DATA_DIR ?? '/var/lib/spectre';
const containerName = dataDir === '/var/lib/spectre' ? 'spectre-sandbox'
  : `spectre-sbx-${createHash('sha256').update(dataDir).digest('hex').slice(0, 8)}`;
const dockerOk = await dockerAvailable();
// 自测-5: 静默降级→显式告警。local 驱动是合法形态, 但 docker 缺席
// 意味着隔离边界/工具链差异未被告知——boot 日志一行+可 grep 标记。
if (!dockerOk && !process.env.SPECTRE_SANDBOX_DRIVER) {
  console.warn('[sandbox] docker 不可用, 已降级 local 驱动(命令直接跑在宿主)——'
    + '如需容器隔离请安装 docker 后重跑 deploy/setup.sh');
}
let cfg = {
  driver: process.env.SPECTRE_SANDBOX_DRIVER
    ?? (dockerOk ? 'docker' : 'local'),
  container: process.env.SPECTRE_SANDBOX_CONTAINER ?? containerName,
  image: 'debian:bookworm-slim',
};


/**
 * Run a bash script through the configured driver (CS1-R2: 此前 7 处
 * docker/local 三元逐字重复)。docker 形态外层再包 timeout(R24-F1:
 * attached exec 不转发信号——只杀宿主客户端则容器内进程存活)。
 * @param {{driver: 'local'|'docker', container?: string}} cfg
 * @param {string} script
 * @param {{timeoutSec?: number, hostTimeoutSec?: number}} [o]
 */
async function runInSandbox(cfg, script, o = {}) {
  const hostTimeout = o.hostTimeoutSec ?? 900;
  if (cfg.driver !== 'docker') {
    return run('bash', ['-lc', script], hostTimeout);
  }
  const inner = o.noInnerTimeout ? '' : 'timeout -k 2 900 ';
  return run('docker', ['exec', cfg.container, ...inner.split(' ').filter(Boolean),
    'bash', '-lc', script], hostTimeout + 10);
}


/** apt 命令行解析(N13: 四处逐字/变体正则收敛; 组1=前缀 组2=flags 组3=包段). */
const APT_INSTALL_RE = /(apt(?:-get)?\s+install\s+)((?:-{1,2}[\w-]+\s+)*)([^;&|]*)/;
const APT_ACT_RE = /apt(?:-get)?\s+(?:install|remove)\s+((?:-{1,2}[\w-]+\s+)*)([^;&|]*)/;
const PKG_WORD_RE = /^[\w.+:~-]+$/;

async function dockerAvailable() {
  return new Promise(resolve => {
    const p = spawn('docker', ['version', '--format', '{{.Server.Version}}'],
      { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', code => resolve(code === 0));
  });
}

export async function loadSandboxConfig() {
  try {
    cfg = { ...cfg, ...JSON.parse(await fsp.readFile(REGISTRY_PATH, 'utf8')) };
  } catch { /* defaults */ }
  if (cfg.driver === 'docker' && !(await dockerAvailable())) {
    console.warn('[sandbox] docker unavailable — falling back to local driver');
    cfg.driver = 'local';
  }
  return cfg;
}

export async function saveSandboxConfig(patch) {
  // undefined values must NOT clobber existing settings
  const clean = Object.fromEntries(Object.entries(patch)
    .filter(([, v]) => v !== undefined));
  cfg = { ...cfg, ...clean };
  await fsp.mkdir(path.dirname(REGISTRY_PATH), { recursive: true });
  await fsp.writeFile(REGISTRY_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

export function sandboxConfig() {
  return { ...cfg };
}

// ---------------------------------------------------------- lifecycle

function run(cmd, args, timeoutSec = 120) {
  return new Promise(resolve => {
    const child = spawn(cmd, args);
    let out = '';
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutSec * 1000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', e => { clearTimeout(t); resolve({ code: -1, out: e.message }); });
    child.on('close', code => { clearTimeout(t); resolve({ code, out }); });
  });
}

/** Ensure the sandbox is up (docker driver): create if missing, start if
 *  stopped, mount workspace/skills/tools volumes. Idempotent. */
export async function ensureSandbox() {
  if (cfg.driver !== 'docker') {
    // local driver: only the host dirs must exist
    for (const d of Object.values(HOST)) {
      await fsp.mkdir(d, { recursive: true });
    }
    const boot = await bootstrapToolchain();
    return { driver: 'local', ok: boot.bootstrapped !== false, ...boot };  // CS28/N4
  }
  for (const d of Object.values(HOST)) {
    await fsp.mkdir(d, { recursive: true });
  }
  const exists = await run('docker', ['inspect', '-f', '{{.State.Running}}',
    cfg.container]);
  if (exists.code === 0) {
    if (exists.out.trim() !== 'true') {
      // R24-F2: start 退出码此前被丢弃——失败仍返回 ok:true, 后续
      // 所有 docker exec 无线索失败。
      const start = await run('docker', ['start', cfg.container]);
      if (start.code !== 0) {
        return { driver: 'docker', ok: false, error: `start failed: ${start.out.slice(-200)}` };
      }
    }
    // R32D53-N4: 存活容器也验 bootstrap marker——此前 exists 早退直接
    // ok:true, 上次 bootstrap 失败(marker 未写)后重启永不重试(文档
    // '重启即重试'不成立, 实测 0 行 bootstrap)。
    const reBoot = await bootstrapToolchain();
    return { driver: 'docker', ok: reBoot.bootstrapped !== false, started: true, ...reBoot };
  }
  const pull = await run('docker', ['pull', cfg.image], 600);
  if (pull.code !== 0) {
    return { driver: 'docker', ok: false, error: `pull failed: ${pull.out.slice(-200)}` };
  }
  const create = await run('docker', [
    'run', '-d', '--init', '--name', cfg.container,
    '--network', 'host',
    '-v', `${HOST.workspace}:/workspace`,
    '-v', `${HOST.skills}:/opt/skills:ro`,
    '-v', `${HOST.tools}:/opt/tools`,
    '-v', `${HOST.uploads}:/opt/uploads`,
    '-w', '/workspace',
    cfg.image, 'sleep', 'infinity',
    // --init(F11): tini 作为 PID1 收割孤儿——sleep infinity 不 wait() 导致
    // docker exec 的孤儿进程永久僵尸化(实测 458 个 Sep15 遗留)。
  ]);
  if (create.code !== 0) {
    // R24-F2: 并发 ensure 双双过 inspect-miss 后竞态 create——败者
    // 的 'name already in use' 是误报(容器实际健康)。重 inspect 收敛。
    const recheck = await run('docker', ['inspect', '-f', '{{.State.Running}}', cfg.container]);
    if (recheck.code === 0 && recheck.out.trim() === 'true') {
      const racedBoot = await bootstrapToolchain();
      return { driver: 'docker', ok: racedBoot.bootstrapped !== false, started: true, raced: true, ...racedBoot };  // CS29-F6: 同款不谎报
    }
    return { driver: 'docker', ok: false, error: create.out.slice(-200) };
  }
  const boot = await bootstrapToolchain();
  // replay the shared-layer install ledger into the fresh container
  // (apt-layer installs would otherwise be silently lost)
  const replayed = await replayInstallLog();
  // 自测-7: 重建不再是静默事件——created:true 让 boot 层发 bus 通知并
  // 清点依赖容器进程态的 shell(此前注册表持久但通道全死, 无任何告知)。
  return { driver: 'docker', ok: boot.bootstrapped !== false, created: true, recreated: true, ...boot, replayed };  // CS29-F6
}

/** install-log: durable record of environment installs; replayed after a
 *  container rebuild (apt-layer packages live in the container layer and
 *  are lost — bind-mounted /opt/tools installs survive). */
const installLogMutex = { p: Promise.resolve() };
function withInstallLog(fn) {
  const run = installLogMutex.p.then(fn, fn);
  installLogMutex.p = run.catch(() => {});
  return run;
}

async function _appendInstallLog(command) {
  const file = path.join(HOST.tools, 'install-log');
  const line = `${new Date().toISOString()}\t${String(command).replace(/\n/g, ' ')}\n`;
  await fsp.mkdir(HOST.tools, { recursive: true });
  await fsp.appendFile(file, line, 'utf8');
}

export async function replayInstallLog() {
  const file = path.join(HOST.tools, 'install-log');
  let lines = [];
  try { lines = (await fsp.readFile(file, 'utf8')).split('\n'); }
  catch { return { replayed: 0 }; }
  let n = 0;
  for (const line of lines) {
    // R24-F4: 镜像 _readInstallLog 宽容解析(round-3 决议: 手写裸行
    // 就是命令)——严格 TSV 使裸行安装重建后永久丢失而 UI 仍列出。
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cmd = trimmed.includes('\t') ? trimmed.split('\t')[1] : trimmed;
    if (!cmd) continue;
    // R24-F1: 容器内 timeout 包装(R5-F5 契约——attached exec 不转发
    // 信号, 只杀宿主客户端则容器内安装存活且账本不记)。
    const res = await runInSandbox(cfg, cmd);
    n += res.code === 0 ? 1 : 0;
  }
  return { replayed: n, total: n };
}

/** Toolchain bootstrap — the base image is bare; every scenario of the
 *  tooling agent (clone/build/test a server) needs node/python/git.
 *  Idempotent via a marker file on the PERSISTED /opt/tools mount, so a
 *  container rebuild skips it when the marker survives. */
function bootstrapScript() {
  // Container-side base dir for docker; the HOST mount dir for local
  // (the local driver runs on the host — container paths must not leak).
  const base = cfg.driver === 'docker' ? '/opt/tools' : HOST.tools;
  const uploads = cfg.driver === 'docker' ? '/opt/uploads' : HOST.uploads;
  // R24-1(二十四轮): local driver 此前直接 `npm/pip3 config set`——写的是
  // 宿主用户级 ~/.npmrc 与 pip 全局配置, 数据目录删除后宿主 pip/npm 即坏。
  // 改为只写 base 内的项目级配置文件, 宿主配置零触碰。
  const cfgFiles = cfg.driver === 'docker'
    ? [`npm config set prefix ${base}/npm-global || true`,
       `pip3 config set global.target ${base}/py || true`]
    : [`printf 'prefix=%s/npm-global\n' '${base}' > ${base}/.npmrc || true`,
       `mkdir -p ${base}/pip && printf '[global]\ntarget = %s/py\n' '${base}' > ${base}/pip/pip.conf || true`];
  return [
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    `mkdir -p ${base}/bin ${base}/npm-global ${uploads}`,
    // R32D58-F2(P1)/CS36-Z1(P0): 宿主 apt 守卫仅 local 驱动——docker 位
    // 在容器内执行(无宿主变异), 恢复无条件 bootstrap(README Docker 承诺);
    // 先例 bootstrap-sandbox.sh 的 [ ! -f /.dockerenv ] 前半即此语义。
    ...(cfg.driver !== 'docker'
      ? ['if [ "${SPECTRE_ALLOW_HOST_BOOTSTRAP:-0}" != "1" ]; then '
         + 'echo "[sandbox][local] 跳过宿主 apt(装基础包须显式 SPECTRE_ALLOW_HOST_BOOTSTRAP=1)" >&2; '
         + 'elif command -v apt-get >/dev/null 2>&1; then '
         + 'apt-get update -qq && apt install -y -qq '
         + 'nodejs npm python3 python3-pip git curl unzip build-essential jq >/dev/null || exit 100; fi']
      : ['if command -v apt-get >/dev/null 2>&1; then '
         + 'apt-get update -qq && apt install -y -qq '
         + 'nodejs npm python3 python3-pip git curl unzip build-essential jq >/dev/null || exit 100; fi']),
    ...cfgFiles,
    `date -Iseconds > ${base}/.bootstrapped`,
  ].join('\n');
}

async function bootstrapToolchain() {
  // The marker must bind to the CONTAINER identity: apt-layer packages
  // live in the container layer, so a rebuilt container loses them even
  // though the persisted-volume marker survives — bind it to the
  // container Id and bootstrap again when the Id changes.
  let identity = 'local';
  if (cfg.driver === 'docker') {
    const id = await run('docker', ['inspect', '-f', '{{.Id}}', cfg.container], 30);
    if (id.code !== 0) return { bootstrapped: false, error: 'container missing' };
    identity = id.out.trim().slice(0, 12);
  }
  const markerHost = path.join(HOST.tools, '.bootstrapped');
  const marker = cfg.driver === 'docker'
    ? await run('docker', ['exec', cfg.container, 'cat', '/opt/tools/.bootstrapped'], 30)
    : await run('cat', [markerHost], 30);
  if (marker.code === 0 && marker.out.trim() === identity) {
    return { bootstrapped: true, skipped: true };
  }
  const script = bootstrapScript();
  const res = await runInSandbox(cfg, script);
  // R24-3: 输出单行化——此前多行 apt 输出与状态粘连不可读
  // R26: 固定文案——此前取尾行, apt/pip 的 WARNING/Writing 行语义拧巴
  const noapt = cfg.driver !== 'docker' && process.env.SPECTRE_ALLOW_HOST_BOOTSTRAP !== '1';
  console.log(`[sandbox] bootstrap ${res.code === 0 ? 'ok' : 'FAILED'}${noapt ? '(跳过宿主 apt——SPECTRE_ALLOW_HOST_BOOTSTRAP=1 可装)' : '(基础包 nodejs/python3/git/build-essential)'}${res.code === 0 ? '' : `: ${String(res.out).slice(-160)}`}`);
  if (res.code !== 0) {
    // R32D52-N4: 失败不写 marker(下次启动重试)且不谎报 ok——此前
    // 失败仍返回 ok:true, 调用方(健康面)与文档承诺脱节。
    return { bootstrapped: false, error: `bootstrap exit ${res.code}: ${String(res.out).slice(-160)}` };
  }
  // write the identity marker + ledger the apt toolchain so a rebuild
  // can replay it even if the marker path itself is ever lost
  // R24-2: marker 路径与读路径同源(base)——local 此前硬编码 /opt/tools
  // (写穿隔离且与 markerHost 不匹配, 每次启动全量重跑 bootstrap)。
  // CS36-Z1: local 未装 apt(跳过路径)时身份携 -noapt——下次启动 marker
  // 不匹配→重跑重判(env 后补 SPECTRE_ALLOW_HOST_BOOTSTRAP=1 即可生效),
  // 而非被无差别 marker 永久短路。
  const writeBase = cfg.driver === 'docker' ? '/opt/tools' : HOST.tools;
  const mark = cfg.driver !== 'docker' && process.env.SPECTRE_ALLOW_HOST_BOOTSTRAP !== '1'
    ? identity + '-noapt' : identity;
  const write = `printf '%s' ${mark} > ${writeBase}/.bootstrapped`;
  if (cfg.driver === 'docker') {
    await run('docker', ['exec', cfg.container, 'sh', '-c', write], 30);
  } else {
    await run('sh', ['-c', write], 30);
  }
  await appendInstallLog('apt-get install -y nodejs npm python3 python3-pip git curl unzip jq build-essential').catch(() => {});
  return { bootstrapped: true, output: res.out.slice(-500) };  // CS28-A3: 恒真条件删
}

/** Install shared CLI tooling (runs inside the sandbox for docker
 *  driver; on host for local). Installs persist via the mounts. */
export async function installCli(command) {
  const safeCmd = String(command).slice(0, 4000);
  const res = await runInSandbox(cfg, safeCmd);
  // R32D69-F2: 账本准入与 bash 通道同门槛(looksLikeInstall——此前 REST
  // 通道任意 rc=0 命令(含诊断 cat/ls)无条件入账, 重建时逐条盲重放;
  // 本轮实测 17 条记账仅 2 条真安装)。
  if (res.code === 0 && looksLikeInstall(safeCmd)) await appendInstallLog(safeCmd);
  return { exitCode: res.code, output: res.out.slice(-4000), ok: res.code === 0 };
}

/** Installed-tool listing (for the console CLI page): common binaries. */
export async function listInstalledTools() {
  const probe = 'for d in /usr/local/bin /usr/bin /opt/tools/bin; do '
    + '[ -d "$d" ] && ls "$d"; done | sort -u | head -400';
  const res = await runInSandbox(cfg, probe, { hostTimeoutSec: 60, noInnerTimeout: true });
  return res.code === 0 ? res.out.split('\n').filter(Boolean) : [];
}

/** An install verb must sit at a COMMAND position (segment start, or
 *  right after && ; | ( ) — a substring match once let a quoted
 *  `grep -c "apt-get install"` row count as an install row (round-4). */
const APT_CMD_POS = /(?:^|&&|;|\|\||\||\()\s*(?:sudo\s+)?apt(?:-get)?\s+install\b/;
/** Rewrite an apt ledger line WITHOUT one package — keeps the row's
 *  replay value for sibling packages when only one is uninstalled
 *  (round-4: deleting the whole row orphaned the siblings' replay). */
export function rewriteAptLineWithout(line, pkg) {
  // Token-level removal INSIDE the package segment only — a rebuild
  // from captured pieces once amputated a `2>` redirect (round-5:
  // replayed row became `jq&1`, backgrounded apt + dpkg lock races).
  const m = String(line).match(APT_INSTALL_RE);
  if (!m) return null;
  const seg = m[3];
  const cleaned = seg.replace(new RegExp(`(^|\\s)${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`), ' ');  // R24-F5: 转义
  if (cleaned === seg) return null;
  return line.slice(0, m.index) + m[1] + m[2] + cleaned
    + line.slice(m.index + m[0].length);
}

export function isAptInstallRow(cmd) {
  return APT_CMD_POS.test(String(cmd));
}

/** Heuristic: does this bash command install into the shared layer?
 *  bash-side installs bypass the install REST, so the adapter layer
 *  calls this to keep the ledger complete (round-3 review: the ledger
 *  was write-starved for npm/pip installs). */
const INSTALL_CMD_RE
  = /(npm[^|;&]*--prefix[^|;&]*opt\/tools|pip\d?[^|;&]*--target[^|;&]*opt\/tools)/;
export function looksLikeInstall(command) {
  return INSTALL_CMD_RE.test(String(command)) || isAptInstallRow(command);
}

/** List recorded install commands (the shared-layer ledger). */
async function _readInstallLog() {
  const file = path.join(HOST.tools, 'install-log');
  try {
    const lines = (await fsp.readFile(file, 'utf8')).split('\n');
    // TSV rows use column 2; a hand-written bare line IS the command
    // (lenient parse — round-3 review: strict TSV dropped such rows).
    return lines.map(l => l.includes('\t') ? l.split('\t')[1] : l.trim())
      .filter(Boolean);
  } catch { return []; }
}

/** Remove install-log lines whose command contains `match` — prevents a
 *  container rebuild from resurrecting an uninstalled tool. Returns the
 *  removed command strings. */
async function _removeInstallLogEntries(match, keepCmds = new Set()) {
  const file = path.join(HOST.tools, 'install-log');
  let lines;
  try { lines = (await fsp.readFile(file, 'utf8')).split('\n'); }
  catch { return []; }
  const removed = [];
  const keep = [];
  for (const line of lines) {
    const cmd = line.includes('\t') ? line.split('\t')[1] : line.trim();
    // only real package-manager rows are eligible — a bare
    // includes(match) once ate unrelated lines that merely mention the
    // name (a sed cleanup row, round-3 review)
    const isInstallRow = cmd && cmd.includes(match) && !keepCmds.has(cmd)
      && (isAptInstallRow(cmd)
        || /(npm|pip\d?|yarn|pnpm|curl|wget|git clone|make)/.test(cmd));
    if (isInstallRow) removed.push(cmd);
    else keep.push(line);
  }
  await fsp.writeFile(file, keep.join('\n'), 'utf8');
  return removed;
}

async function rmIfFound(p) {
  // lstat, NOT stat: stat FOLLOWS symlinks, so a dangling bin link
  // (its package dir just removed) reads as ENOENT and could never be
  // cleaned — the exact bug the round-3 review caught twice.
  try { await fsp.lstat(p); } catch { return false; }
  await fsp.rm(p, { recursive: true, force: true });
  return true;
}

/** Uninstall a CLI from the shared layer. Probes the install layouts
 *  (bare binary in bin/, pip --target dir + versioned dist-info,
 *  npm --prefix node_modules + bin link), removes what it finds, then
 *  clears matching install-log entries. Host paths are bind-mounted
 *  into the sandbox, so host-side removal works for every driver. */
export async function uninstallCliTool(name) {
  // reject path traversal: '..' anywhere would let a name like '..' or
  // '../x' escape the layout root (tools/bin/.. == tools itself)
  if (!/^[$\w@+][$\w@./+-]*$/.test(name) || name.includes('..')
    || /[./]$/.test(name)) {
    throw new Error(`invalid tool name: ${name}`);
  }
  const removed = [];
  const tryRm = async p => { if (await rmIfFound(p)) removed.push(p); };
  await tryRm(`${HOST.tools}/bin/${name}`);
  await tryRm(`${HOST.tools}/py/${name}`);
  // pip versioned dist-info siblings (<name>-<ver>.dist-info)
  try {
    for (const ent of await fsp.readdir(`${HOST.tools}/py`)) {
      if (ent.startsWith(`${name}-`) && ent.endsWith('.dist-info')) {
        await tryRm(`${HOST.tools}/py/${ent}`);
      }
    }
  } catch { /* py/ absent */ }
  await tryRm(`${HOST.tools}/npm-global/lib/node_modules/${name}`);
  await tryRm(`${HOST.tools}/npm-global/bin/${name}`);
  // sweep bin links that pointed into the removed package dir —
  // robust against pre-deleted package dirs and non-matching link
  // names (round-3 review: dangling links survived, exit 127)
  try {
    const binDir = `${HOST.tools}/npm-global/bin`;
    for (const ent of await fsp.readdir(binDir)) {
      const p = `${binDir}/${ent}`;
      let target;
      try { target = await fsp.readlink(p); } catch { continue; }
      if (target.includes(`node_modules/${name}/`)
        || target.includes(`node_modules/${name}`) && !/[\w.-]/.test(target.split(`node_modules/${name}`)[1]?.[0] ?? '')) {
        await tryRm(p);
      }
    }
  } catch { /* bin/ absent */ }
  // apt-layer uninstall: the ledger accepts apt installs (container-
  // layer packages NEED replay after rebuild), so removal must be
  // symmetric — otherwise the ledger row vanishes while the package
  // stays (round-3 review: audit-chain break, permanent inconsistency).
  const aptRemoved = [];
  const ledger = await readInstallLog();
  const aptLines = ledger.filter(l => isAptInstallRow(l) && l.includes(name));
  if (aptLines.length) {
    // Extract ONLY the tokens after `apt(-get) install [flags]`, up to
    // the next shell control token — real hand-installed ledger lines
    // are compound commands (`export X=1 && apt-get install -y figlet`);
    // a naive whitespace split once fed `export`, `&&`, env assignments
    // to apt-get as package names (round-3 review).
    const pkgs = [...new Set(aptLines.flatMap(l => {
      const m = l.match(APT_ACT_RE);
      return m ? m[2].trim().split(/\s+/)
        // strict package-name shape: redirects (2>/dev/null), env
        // assignments and shell tokens can never look like this
        .filter(w => PKG_WORD_RE.test(w)) : [];
    }))];
    // P0: zero extracted names must ABORT — a bare `apt-get remove
    // --purge` exits 0 having removed nothing, the receipt would then
    // claim success while packages stay (round-3 review).
    if (!pkgs.length) {
      aptRemoved.push(`ABORTED: 账本有 apt 行但提取到 0 个包名`
        + `(行:${aptLines[0].slice(0, 120)});请 bash 手动 apt-get purge ${name}`);
    } else {
      // No collateral removal (round-4 review): uninstall ONLY the
      // requested name; same-row siblings stay (receipt says so).
      const siblings = pkgs.filter(p => p !== name);
      const targets = pkgs.includes(name) ? [name] : pkgs;
      const rmCmd = `apt-get remove -y --purge ${targets.join(' ')}`;
      const res = await runInSandbox(cfg, rmCmd, { hostTimeoutSec: 120, noInnerTimeout: true });
      // P0: exit 0 is NOT proof — dpkg -l must show no 'ii' rows for
      // the packages before this counts as removed.
      let verified = res.code === 0;
      if (verified) {
        const chkCmd = `dpkg -l ${targets.join(' ')} 2>/dev/null | grep -c '^ii' || true`;
        const chk = await runInSandbox(cfg, chkCmd, { hostTimeoutSec: 60, noInnerTimeout: true });
        verified = String(chk.out ?? '').trim() === '0';
      }
      const noteTail = (siblings.length
        ? `(同账本行还装了 ${siblings.join(',')},未动——如需一并卸载请分别 uninstall)` : '')
        + (verified ? `(dpkg -l 复验:${targets.join(',')} 已无 ii 行)` : '');
      if (verified) {
        // alternatives awareness: `which figlet` can still hit a
        // symlink owned by another package (toilet's figlet) — the
        // receipt must not read as failure, nor stay silent (round-5)
        const altCmd = `command -v ${name} || true`;
        const alt = await runInSandbox(cfg, altCmd, { hostTimeoutSec: 30, noInnerTimeout: true });
        const altNote = String(alt.out ?? '').trim()
          ? `(注:command -v ${name} 仍命中——dpkg 层已移除,命令可能来自 alternatives/系统其它包提供)` : '';
        aptRemoved.push(rmCmd + noteTail + altNote);
      }
      else aptRemoved.push(`FAILED(${res.code}): ${rmCmd}`
        + `(包可能残留,请 bash dpkg -l 复核并手动处理)`);
    }
  }
  // ABORT keeps its ledger rows — deleting them would orphan really
  // installed packages (ghost window, round-4 P2)
  const aborted = aptRemoved.some(a => a.startsWith('ABORTED'));
  const abortKeep = new Set(aborted ? aptLines : []);
  const clearedLog = await removeInstallLogEntries(name, abortKeep);
  // Sibling-preserving rewrite: a row that installed figlet+jq loses
  // only figlet — the rewritten row keeps jq's replay value intact.
  if (!aborted) {
    const rewrites = [];
    for (const line of aptLines) {
      const m = String(line).match(APT_INSTALL_RE);
      const pkgs2 = m ? m[3].trim().split(/\s+/).filter(w => PKG_WORD_RE.test(w)) : [];
      if (pkgs2.length > 1 && pkgs2.includes(name)) {
        const rw = rewriteAptLineWithout(line, name);
        if (rw && /\binstall\b/.test(rw)) rewrites.push(rw);
      }
    }
    for (const rw of rewrites) await appendInstallLog(rw);
    return { removed, aptRemoved, clearedLog, rewritten: rewrites };
  }
  return { removed, aptRemoved, clearedLog, rewritten: [] };
}

/** Tools actually installed in the shared layer (uninstallable set):
 *  fs-probe the three layouts + package names parsed from the apt
 *  ledger rows. Drives the CLI page's "shared layer" section — the
 *  bare PATH listing must never carry uninstall buttons (system
 *  commands are not ours to remove). */
export function appendInstallLog(cmd) { return withInstallLog(() => _appendInstallLog(cmd)); }
export function removeInstallLogEntries(match, keep) { return withInstallLog(() => _removeInstallLogEntries(match, keep)); }
export function readInstallLog() { return withInstallLog(() => _readInstallLog()); }

export async function sharedLayerTools() {
  const out = [];
  const seen = new Set();
  const push = (name, layer, note = '') => {
    if (!name || seen.has(`${layer}:${name}`)) return;
    seen.add(`${layer}:${name}`);
    out.push({ name, layer, note });
  };
  try {
    for (const ent of await fsp.readdir(`${HOST.tools}/npm-global/lib/node_modules`)) {
      if (!ent.startsWith('.')) push(ent, 'npm');
    }
  } catch { /* absent */ }
  try {
    for (const ent of await fsp.readdir(`${HOST.tools}/py`)) {
      if (!ent.startsWith('.') && !ent.endsWith('.dist-info')) push(ent, 'pip');
    }
  } catch { /* absent */ }
  try {
    for (const ent of await fsp.readdir(`${HOST.tools}/bin`)) {
      if (!ent.startsWith('.')) push(ent, 'bin');
    }
  } catch { /* absent */ }
  for (const line of await readInstallLog()) {
    if (!isAptInstallRow(line)) continue;
    const m = String(line).match(APT_INSTALL_RE);
    const pkgs = m ? m[3].trim().split(/\s+/)
      .filter(w => PKG_WORD_RE.test(w)) : [];
    for (const p of pkgs) push(p, 'apt', line.slice(0, 100));
  }
  return out;
}

