/**
 * prefs-guard (CS46-F6a 机锁): PUT /api/prefs 三面守卫(currentWs id 域 /
 * ui 形状 / 凭据子树拒)与 setPrefs 嵌套 stackRatios 形状——纯函数面直测,
 * 防 F1 类(正则与 id 域分叉)盲区回归。
 * HTTP 面由 prefs-http.test.mjs 覆盖(CD 批次, CS47-N5 债已清)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('currentWs 校验与 workSessionId 同 id 域(CS46-F1 锁)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prefs-guard-'));
  process.env.SPECTRE_DATA_DIR = dir;
  process.env.INTERNAL_TOKEN ||= 'prefs-guard';
  const prevCwd = process.cwd();
  process.chdir(join(ROOT, 'backend'));
  try {
    const { setPrefs, getPrefs } = await import('../src/projects.mjs');
    // 非 ws- 前缀项目 id 是合法域(与 routes workSessionId 同)
    setPrefs({ currentWs: 'proj-abc123', ui: { theme: 'dark' } });
    assert.equal(getPrefs().currentWs, 'proj-abc123', '非 ws- 前缀 id 必须可持久化(F1: console switch 路径)');
    // 嵌套形状守卫(F6b/N3): 字符串/数组均拒
    assert.throws(() => setPrefs({ ui: { stackRatios: 'garbage' } }), /stackRatios 须为普通对象/);
    assert.throws(() => setPrefs({ ui: { stackRatios: [0.4, 0.3] } }), /stackRatios 须为普通对象/);
    // 值形状=number[]|null(CS47-N4: 消费契约 PanelStack——标量拒)
    assert.throws(() => setPrefs({ ui: { stackRatios: { 'stage:recon': 0.4 } } }), /number\[\] 或 null/);
    setPrefs({ ui: { stackRatios: { 'stage:recon': [0.4, 0.3], 'even': null } } });
    assert.deepEqual(getPrefs().ui.stackRatios['stage:recon'], [0.4, 0.3]);
  } finally {
    process.chdir(prevCwd);
    delete process.env.SPECTRE_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routes 侧 currentWs 正则与 workSessionId 同字符类(源锚锁)', async () => {
  const src = readFileSync(join(ROOT, 'backend/src/routes.mjs'), 'utf8');
  // 抽取全部 ^[\\w-]+$ 形态的 id 域正则字面量——两处必须同字符类,
  // 分叉即红(F1 根因: currentWs 曾用 ws- 前缀专属正则)。
  const reLits = src.match(/\/\^\[\\w-\]\+\$\//g) ?? [];
  assert.ok(reLits.length >= 2, `id 域正则(^[\\w-]+$)应≥2 处(workSessionId/currentWs), 实得 ${reLits.length}`);
  // currentWs 行若出现 ws- 前缀专属正则即为分叉(F1 根因)
  const cwLines = src.split('\n').filter(l => l.includes('currentWs'));
  assert.ok(!cwLines.some(l => /ws-\[a-z0-9\]/.test(l)), 'currentWs 不得用 ws- 前缀专属正则');
  assert.match(src, /currentWs 须为项目 id 字符串/, 'currentWs 文案在');
});
