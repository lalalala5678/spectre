/**
 * CS21-1 机锁: shell 审计载荷必须穿透真实 Bus 白名单。
 *
 * 背景: shell 审计两跳丢失各存活多轮——第一跳(适配器签名)CS20 发现,
 * 第二跳(Bus.emit 固定字段白名单滤掉 kind/at/id/target/cmd/code/ms)
 * CS21 发现且 AG 批次的"单元活体"因用 mock bus 而未实锤。本测试走
 * 真实 Bus: 断言 WAL 事件含映射后的 summary(kind·shell·命令)与
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
