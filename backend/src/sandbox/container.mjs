/**
 * Sandbox lifecycle + shared CLI layer + the mount registry
 * (sandbox driver settings). One LONG-LIVED container by design: CLI
 * tools are installed once and shared by every agent of every project;
 * project isolation is directory-level (cross-project reads are an
 * intentional feature).
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { HOST, ensureWorkspace } from './exec-env.mjs';

const REGISTRY_PATH = path.join(HOST.workspace, '..', 'sandbox-config.json');

// ------------------------------------------------------------- registry

let cfg = {
  driver: process.env.SPECTRE_SANDBOX_DRIVER
    ?? (await dockerAvailable() ? 'docker' : 'local'),
  container: 'spectre-sandbox',
  image: 'debian:bookworm-slim',
};

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
    return { driver: 'local', ok: true };
  }
  for (const d of Object.values(HOST)) {
    await fsp.mkdir(d, { recursive: true });
  }
  const exists = await run('docker', ['inspect', '-f', '{{.State.Running}}',
    cfg.container]);
  if (exists.code === 0) {
    if (exists.out.trim() !== 'true') {
      await run('docker', ['start', cfg.container]);
    }
    return { driver: 'docker', ok: true, started: true };
  }
  const pull = await run('docker', ['pull', cfg.image], 600);
  if (pull.code !== 0) {
    return { driver: 'docker', ok: false, error: `pull failed: ${pull.out.slice(-200)}` };
  }
  const create = await run('docker', [
    'run', '-d', '--name', cfg.container,
    '--network', 'host',
    '-v', `${HOST.workspace}:/workspace`,
    '-v', `${HOST.skills}:/opt/skills:ro`,
    '-v', `${HOST.tools}:/opt/tools`,
    '-w', '/workspace',
    cfg.image, 'sleep', 'infinity',
  ]);
  if (create.code !== 0) {
    return { driver: 'docker', ok: false, error: create.out.slice(-200) };
  }
  return { driver: 'docker', ok: true, created: true };
}

/** Install shared CLI tooling (runs inside the sandbox for docker
 *  driver; on host for local). Installs persist via the mounts. */
export async function installCli(command) {
  const safeCmd = String(command).slice(0, 4000);
  const res = cfg.driver === 'docker'
    ? await run('docker', ['exec', cfg.container, 'bash', '-lc', safeCmd], 900)
    : await run('bash', ['-lc', safeCmd], 900);
  return { exitCode: res.code, output: res.out.slice(-4000), ok: res.code === 0 };
}

/** Installed-tool listing (for the console CLI page): common binaries. */
export async function listInstalledTools() {
  const probe = 'for d in /usr/local/bin /usr/bin /opt/tools/bin; do '
    + '[ -d "$d" ] && ls "$d"; done | sort -u | head -400';
  const res = cfg.driver === 'docker'
    ? await run('docker', ['exec', cfg.container, 'bash', '-lc', probe], 60)
    : await run('bash', ['-lc', probe], 60);
  return res.code === 0 ? res.out.split('\n').filter(Boolean) : [];
}

export { ensureWorkspace };
