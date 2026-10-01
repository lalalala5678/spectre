/**
 * gate-matrix (R32D59-N2 建议): C2/phish 门族矩阵机锁——
 * env=1 × {无 scope, 空 targets scope} × 全族工具, 断言退出码统一
 * (76; 此前 c2-variant 门序倒挂 75 + 缺文件裸栈 1, 提交信息两轮虚报)。
 * 纯 python 子进程+临时数据根, 无网络无端口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(ROOT, 'tools', 'bin');

function runTool(tool, args, dataDir, edusrc) {
  const env = { ...process.env, SPECTRE_DATA_DIR: dataDir };
  if (edusrc) env.SPECTRE_EDUSRC = '1'; else delete env.SPECTRE_EDUSRC;
  return spawnSync('python3', [join(BIN, tool), ...args], { env, encoding: 'utf8', timeout: 20000 });
}

test('门族矩阵: env=1 下缺/空 scope 全族统一 76(无裸栈)', () => {
  const emptyDir = mkdtempSync(join(tmpdir(), 'gate-e-'));
  mkdirSync(join(emptyDir, 'tools', 'c2'), { recursive: true });
  // 空 targets scope: 文件在但 targets 空
  writeFileSync(join(emptyDir, 'tools', 'c2', 'scope.json'),
    JSON.stringify({ exercise: 'qa', targets: [], window: { start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z' } }));
  const noDir = mkdtempSync(join(tmpdir(), 'gate-n-'));
  mkdirSync(join(noDir, 'tools', 'c2'), { recursive: true });

  // 前置: 供给一个有效 payload 让参数校验先过
  const payload = join(emptyDir, 'p.php');
  writeFileSync(payload, '<?php // SPECTRE-MARK\n');
  const cases = [
    ['c2-qa.py', ['scan', '--engine', 'echo']],
    ['c2-basetype.py', ['list']],
    ['c2-bytecode.py', ['selftest']],
    ['c2-variant.py', ['gen', '--src', payload, '--out', join(emptyDir, 'o')]],
  ];
  try {
    for (const [tool, args] of cases) {
      for (const [dir, label] of [[noDir, '无scope'], [emptyDir, '空targets']]) {
        const r = runTool(tool, args, dir, true);
        assert.equal(r.status, 76, `${tool}/${label}: env=1 应 76, 实得 ${r.status}\nstdout:${r.stdout?.slice(-200)}\nstderr:${r.stderr?.slice(-300)}`);
        assert.ok(!r.stderr.includes('Traceback'), `${tool}/${label}: 不得裸栈`);
      }
    }
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
    rmSync(noDir, { recursive: true, force: true });
  }
});

test('无 env: 缺 scope 全族干净 75(非裸栈)', () => {
  const noDir = mkdtempSync(join(tmpdir(), 'gate-p-'));
  mkdirSync(join(noDir, 'tools', 'c2'), { recursive: true });
  const payload = join(noDir, 'p.php');
  writeFileSync(payload, '<?php // SPECTRE-MARK\n');
  try {
    for (const [tool, args] of [
      ['c2-qa.py', ['scan', '--engine', 'echo']],
      ['c2-variant.py', ['gen', '--src', payload, '--out', join(noDir, 'o')]],
      ['c2-bind.py', ['bind', '--payload', payload]],
    ]) {
      const r = runTool(tool, args, noDir, false);
      assert.equal(r.status, 75, `${tool}: 无 env 缺 scope 应干净 75, 实得 ${r.status}`);
      assert.ok(!r.stderr.includes('Traceback'), `${tool}: 不得裸栈`);
    }
  } finally {
    rmSync(noDir, { recursive: true, force: true });
  }
});
