/**
 * CS21-1 机锁: shell 审计载荷必须穿透真实 Bus 白名单。
 *
 * 背景: shell 审计两跳丢失各存活多轮——第一跳(适配器签名)CS20 发现,
 * 第二跳(Bus.emit 固定字段白名单滤掉 kind/at/id/target/cmd/code/ms)
 * CS21 发现且 AG 批次的"单元活体"因用 mock bus 而未实锤。本测试走
 * 真实 Bus: 断言 WAL 事件含映射后的 summary(kind·shell·target·命令)与
 * detail(JSON 全量)——任何一跳再断, 这里红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKEND = join(ROOT, 'backend');

test('CS21-1: shell 审计载荷穿透真实 Bus(白名单映射后可见)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shellbus-'));
  try {
    const script = `
process.env.SPECTRE_DATA_DIR = ${JSON.stringify(dir)};
process.env.SPECTRE_SANDBOX_DRIVER = 'local';
const { mkdirSync } = await import('node:fs');
mkdirSync(${JSON.stringify(dir)}, { recursive: true });
const { Bus } = await import('./src/bus.mjs');
const { Wal } = await import('./src/persist.mjs');
const wal = new Wal(${JSON.stringify(join(dir, 'state.wal'))});
wal.open();
const bus = new Bus(wal);
const { shellBusAdapter } = await import('./src/shells.mjs');
const { createShellRegistry } = await import('./src/shells.mjs');
const reg = createShellRegistry({ bus: shellBusAdapter(bus),
  listScope: () => ({ targets: ['*.local'],
    window: { start: '2020-01-01T00:00:00Z', end: '2099-01-01T00:00:00Z' }, exercise: 'cs21' }) });
const sh = reg.register({ transport: 'local', transportRef: 'pxlab',
  target: 'cs21-box.local', name: 'cs21', createdBy: 'test' });
const events = bus.list().filter(e => e.type === 'shell-event');
const ev = events[events.length - 1];
console.log(JSON.stringify({ ok: Boolean(ev),
  summary: ev?.summary ?? '', hasDetail: Boolean(ev?.detail),
  detailHasKind: ev?.detail ? ev.detail.includes('shell-register') : false,
  shellId: sh?.id ?? null }));
`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-'], {
      input: script, encoding: 'utf8', timeout: 30000, cwd: BACKEND,
    });
    if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.ok(out.ok, 'shell-event 未入总线');
    assert.match(out.summary, /shell-register/, `summary 缺 kind: ${out.summary}`);
    assert.match(out.summary, new RegExp(out.shellId), `summary 缺 shell id: ${out.summary}`);
    assert.ok(out.hasDetail && out.detailHasKind, 'detail 缺 JSON 全量载荷');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CS27-15: targetMatches 语义机锁(通配/裸目标子域/大小写)', () => {
  const cases = [
    // [pattern, target, expected]
    ['*.foo.com', 'sub.foo.com', true],
    ['*.foo.com', 'foo.com', false],          // 通配不吃裸域
    ['foo.com', 'sub.foo.com', false],        // CS27-5: 裸目标不再吃点后缀子域
    ['foo.com', 'FOO.com', true],             // 大小写不敏感
    ['*.FOO.com', 'sub.foo.com', true],
    ['203.0.113.0/24', '203.0.113.5', false], // 网段不参与(如 SKILL 所述)
  ];
  const dir = mkdtempSync(join(tmpdir(), 'tm-'));
  try {
    const src = [
      `process.env.SPECTRE_DATA_DIR = ${JSON.stringify(dir)};`,
      "const m = await import('./src/shells.mjs');",
      "// targetMatches 未导出——经 registry 语义等价面验证不可行, 直接源断言",
      "const fs = await import('node:fs');",
      "const src = fs.readFileSync('./src/shells.mjs', 'utf8');",
      "const mm = src.match(/function targetMatches\\(t, target\\) \\{[\\s\\S]*?\\n\\}/);",
      "if (!mm) { console.log(JSON.stringify({ ok: false, err: 'no fn' })); process.exit(0); }",
      `const cases = ${JSON.stringify(cases)};`,
      "const fn = new Function('t', 'target', mm[0].replace('function targetMatches(t, target) {', 'return (' + 'function (t, target) {') + ')');",
      "// 还原函数体: 包一层 eval",
      "const body = mm[0]; const f = eval('(' + body + ')');",
      "const out = cases.map(([p2, t2, exp]) => { const got = f(p2, t2); return got === exp; });",
      "console.log(JSON.stringify({ ok: out.every(Boolean), results: out }));",
    ].join('\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-'], {
      input: src, encoding: 'utf8', timeout: 30000, cwd: BACKEND,
    });
    if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.ok(out.ok, `targetMatches 语义回归: ${JSON.stringify(out.results)}——改匹配器须同步 scope-gate SKILL 与本锁`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
