/**
 * 2026-10-12 WAL 轮换中断恢复回归(用户故障注入实测场景):
 * compact 流程 = "主日志 rename→.1 → 写 tmp → tmp rename→主"。在两步之间
 * 崩溃时主日志不存在而备份是全量——启动必须自动回滚最新非空代, 否则
 * 重启读 0 条(恢复缺口)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Wal } from '../src/persist.mjs';

function tmpWal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-rot-'));
  return { dir, file: path.join(dir, 'state.wal') };
}

function seed(file, n) {
  const w = new Wal(file);
  w.open();
  for (let i = 0; i < n; i++) w.append({ t: 'bus', d: { seq: i } });
  w.close();
}

test('轮换中断(主日志被 rename 走, 新日志未落)重启自动从 .1 恢复', () => {
  const { dir, file } = tmpWal();
  try {
    seed(file, 5);
    fs.renameSync(file, `${file}.1`);            // 故障注入: compact 第一步后崩溃
    assert.ok(!fs.existsSync(file), '前置: 主日志不存在');
    const w2 = new Wal(file);
    w2.open();                                     // 启动流程
    const r = w2.readAll();
    assert.equal(r.entries.length, 5, '必须从 .wal.1 自动恢复全部条目');
    w2.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('恢复幂等: 备份保留, 二次 open 不重复不丢失', () => {
  const { dir, file } = tmpWal();
  try {
    seed(file, 5);
    fs.renameSync(file, `${file}.1`);
    for (let round = 0; round < 2; round++) {
      const w = new Wal(file);
      w.open();
      assert.equal(w.readAll().entries.length, 5, `第 ${round + 1} 次 open 后仍 5 条`);
      w.close();
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('多代回退: .1 空时取 .2(最新非空代优先)', () => {
  const { dir, file } = tmpWal();
  try {
    seed(file, 3);
    // 构造: .2 有全量, .1 空, 主不存在
    fs.renameSync(file, `${file}.2`);
    fs.writeFileSync(`${file}.1`, '');
    const w = new Wal(file);
    w.open();
    assert.equal(w.readAll().entries.length, 3, '跨过空 .1 从 .2 恢复');
    w.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('正常路径不受影响: 主日志非空时不碰备份', () => {
  const { dir, file } = tmpWal();
  try {
    seed(file, 7);
    const before = fs.readFileSync(file, 'utf8');
    const w = new Wal(file);
    w.open();
    assert.equal(w.readAll().entries.length, 7);
    w.close();
    assert.equal(fs.readFileSync(file, 'utf8'), before, '主日志未被改写');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
