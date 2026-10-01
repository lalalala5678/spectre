/**
 * runtime-url-guard (CS36-Z8): R32D58-F1(P0) 的回归机锁——含字面 ESC
 * 控制字符的请求路径曾使 new URL 抛 ERR_INVALID_URL 于 try 外, 单请求
 * 击杀整个 runtime(0x727 OSC-8 模板可自然触发)。
 * 防线: 真起 runtime(临时数据根+随机高位端口)→裸 socket 发击杀载荷
 * →断言 400 + 进程存活 + health 200。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function onceHealth(port, _tries = 40) {
  return new Promise((resolve, reject) => {
    const t = setInterval(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.status === 200) { clearInterval(t); resolve(); }
      } catch { /* not up yet */ }
    }, 250);
    setTimeout(() => { clearInterval(t); reject(new Error('runtime 未在 10s 内就绪')); }, 10000);
  });
}

function rawReq(port, payload) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: '127.0.0.1', port }, () => s.write(payload));
    let head = '';
    s.on('data', d => { head += d.toString('latin1'); s.destroy(); });
    s.on('close', () => resolve(head.split('\r\n')[0]));
    s.on('error', e => { if (head) resolve(head.split('\r\n')[0]); else reject(e); });
    setTimeout(() => { s.destroy(); resolve(head.split('\r\n')[0] || '(timeout)'); }, 4000);
  });
}

test('ESC 控制字符路径 → 400 且 runtime 存活(F1 P0 回归锁)', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-guard-'));
  writeFileSync(join(dir, '.env'), 'INTERNAL_TOKEN=guard-test-token\n');
  const port = 18000 + (process.pid % 500);
  const child = spawn(process.execPath, ['agent-runtime.mjs'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dir, PORT: String(port), INTERNAL_TOKEN: 'guard-test-token', SPECTRE_SANDBOX_ROOT: dir },
    stdio: 'ignore',
  });
  try {
    await onceHealth(port);
    // R32D58 原始击杀载荷: OSC-8 字面转义(ESC 控制字节)
    const kill = 'GET /\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n';
    const status = await rawReq(port, kill);
    assert.match(status, /^HTTP\/1\.1 400/, `击杀载荷应 400, 实得: ${status}`);
    const h = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(h.status, 200, '击杀后 runtime 必须存活');
    assert.ok(child.exitCode === null, 'runtime 进程未退出');
  } finally {
    child.kill('SIGKILL');
    await new Promise(r => setImmediate(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
