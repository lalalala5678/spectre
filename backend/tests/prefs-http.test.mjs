/**
 * prefs-http (CS50-N4): PUT /api/prefs HTTP 面机锁——守卫路径(null 体/
 * 未知键/凭据子树/ui 非对象/currentWs 域外)与 F5/F6 新行为真起 runtime
 * 验证(prefs-guard 只锁纯函数面, 自述"HTTP 面锁待补"三批次)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function onceUp(port, _tries = 40) {
  return new Promise((resolve, reject) => {
    const t = setInterval(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.status === 200) { clearInterval(t); resolve(); }
      } catch { /* boot */ }
    }, 250);
    setTimeout(() => { clearInterval(t); reject(new Error('runtime 10s 未就绪')); }, 10000);
  });
}

test('PUT /api/prefs 守卫路径 HTTP 面(null/未知键/凭据/ui 形状/currentWs)', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prefs-http-'));
  writeFileSync(join(dir, '.env'), 'INTERNAL_TOKEN=phttp\n');
  const port = 19800 + (process.pid % 150);
  const child = spawn(process.execPath, ['agent-runtime.mjs'], {
    cwd: ROOT,
    env: { ...process.env, SPECTRE_DATA_DIR: dir, PORT: String(port), INTERNAL_TOKEN: 'phttp', SPECTRE_SANDBOX_ROOT: dir },
    stdio: 'ignore',
  });
  const H = { 'X-Internal-Token': 'phttp', 'Content-Type': 'application/json' };
  const put = body => fetch(`http://127.0.0.1:${port}/api/prefs`, { method: 'PUT', headers: H, body: JSON.stringify(body) });
  try {
    await onceUp(port);
    // null 体 / 非对象 / 未知键
    for (const [label, raw] of [['null', 'null'], ['array', '[1]']]) {
      const r = await fetch(`http://127.0.0.1:${port}/api/prefs`, { method: 'PUT', headers: H, body: raw });
      assert.equal(r.status, 400, `${label} 体应 400`);
    }
    assert.equal((await put({ bogusKey: 1 })).status, 400, '未知键应 400');
    // 凭据子树
    assert.equal((await put({ commonSettings: {} })).status, 400, '凭据子树应 400');
    // ui 非对象 / currentWs 域外与类型孔
    assert.equal((await put({ ui: 'garbage' })).status, 400, 'ui 字符串应 400');
    assert.equal((await put({ currentWs: 123 })).status, 400, 'currentWs number 应 400');
    assert.equal((await put({ currentWs: 'bad id!' })).status, 400, 'currentWs 域外应 400');
    // 合法面通过 + 回显掩码面由 settings-shape/getSettings 锁
    const ok = await put({ ui: { theme: 'dark' }, currentWs: 'ws-demo' });
    assert.equal(ok.status, 200, '合法 ui/currentWs 应 200');
    // stackRatios 形状违规 400(非 500——CS48-5)
    const sr = await put({ ui: { stackRatios: { a: 0.4 } } });
    assert.equal(sr.status, 400, 'stackRatios 标量值应 400(曾 500)');
  } finally {
    child.kill('SIGKILL');
    await new Promise(r => setImmediate(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
