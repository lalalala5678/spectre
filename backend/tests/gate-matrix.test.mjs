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
  // CS41-A8: 扩员至 SKILL 全员(qa/basetype/bytecode/variant/javart/
  // functest/disguise)+ bytecode verify/split; 参验在门后(门序契约)。
  const cases = [
    ['c2-qa.py', ['scan', '--engine', 'echo']],
    ['c2-basetype.py', ['list']],
    ['c2-bytecode.py', ['selftest']],
    ['c2-bytecode.py', ['split']],
    ['c2-bytecode.py', ['verify']],
    ['c2-variant.py', ['gen', '--src', payload, '--out', join(emptyDir, 'o')]],
    ['c2-javart.py', ['--src', 'x.java']],
    ['c2-functest.py', ['whatever.php']],
    ['c2-disguise.py', ['check']],
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
    // CS42-F17: 75 面扩员(scope 门全员——javart/functest/disguise
    // 按 SKILL 无 scope 门, 仅在 76 面适用)
    for (const [tool, args] of [
      ['c2-qa.py', ['scan', '--engine', 'echo']],
      ['c2-basetype.py', ['list']],
      ['c2-bytecode.py', ['selftest']],
      ['c2-bytecode.py', ['split']],
      ['c2-bytecode.py', ['verify']],
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

test('门族矩阵: 坏 JSON scope 全族统一干净 75(CS37-F3 形态补位)', () => {
  const badDir = mkdtempSync(join(tmpdir(), 'gate-b-'));
  mkdirSync(join(badDir, 'tools', 'c2'), { recursive: true });
  writeFileSync(join(badDir, 'tools', 'c2', 'scope.json'), 'not json {');
  const payload = join(badDir, 'p.php');
  writeFileSync(payload, '<?php // SPECTRE-MARK\n');
  try {
    for (const [tool, args] of [
      ['c2-qa.py', ['scan', '--engine', 'echo']],
      ['c2-basetype.py', ['list']],
      ['c2-bytecode.py', ['selftest']],
      ['c2-variant.py', ['gen', '--src', payload, '--out', join(badDir, 'o')]],
      ['c2-bind.py', ['bind', '--payload', payload]],
    ]) {
      // bind 按设计无 EDUSRC 门(目标绑定语义另行, SKILL 门表)——只测无 env 侧
      for (const edusrc of tool === 'c2-bind.py' ? [false] : [true, false]) {
        const r = runTool(tool, args, badDir, edusrc);
        const want = edusrc ? 76 : 75;
        assert.equal(r.status, want,
          `${tool}/坏JSON/${edusrc ? 'env=1' : '无env'}: 应 ${want}, 实得 ${r.status}\nstderr:${r.stderr?.slice(-300)}`);
        assert.ok(!r.stderr.includes('Traceback'), `${tool}: 不得裸栈`);
      }
    }
    // R32D64-P3: bind 门序统一(scope 先于用法)——坏 scope 下缺参也 75
    for (const sub of ['verify', 'expire']) {
      const r = runTool('c2-bind.py', [sub], badDir, false);
      assert.equal(r.status, 75, `c2-bind ${sub} 坏scope+缺参应 75(门先), 实得 ${r.status}`);
    }
  } finally {
    rmSync(badDir, { recursive: true, force: true });
  }
});

test('variant selftest 空套件拒假绿 rc=1 且无 NameError(CS40-1/CS41-A3 锁)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-st-'));
  mkdirSync(join(dir, 'tools', 'c2', 'basetypes'), { recursive: true });
  writeFileSync(join(dir, 'tools', 'c2', 'scope.json'),
    JSON.stringify({ exercise: 'qa', targets: ['a.local'], window: { start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z' } }));
  try {
    const r = runTool('c2-variant.py', ['selftest'], dir, false);
    // CS41-A3 裁定: 空套件 rc=1 拒假绿(族内统一 bytecode NEW7 制式)。
    assert.equal(r.status, 1, `selftest 空套件应 rc=1(拒假绿), 实得 ${r.status}\nstderr:${r.stderr?.slice(-300)}`);
    assert.ok(!r.stderr.includes('Traceback') && !r.stderr.includes('NameError'), '不得 NameError/裸栈');
    assert.ok(r.stderr.includes('零载荷基型'), '应给供给指引');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('variant selftest 缺目录干净 rc=2(CS41-A1 锁)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-md-'));
  mkdirSync(join(dir, 'tools', 'c2'), { recursive: true });
  writeFileSync(join(dir, 'tools', 'c2', 'scope.json'),
    JSON.stringify({ exercise: 'qa', targets: ['a.local'], window: { start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z' } }));
  try {
    const r = runTool('c2-variant.py', ['selftest'], dir, false);
    assert.equal(r.status, 2, `缺目录应 rc=2, 实得 ${r.status}`);
    assert.ok(!r.stderr.includes('Traceback'), '不得裸栈');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('c2-qa run/scan 缺文件干净 rc=2(CS52-F1 锁)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-qa-'));
  mkdirSync(join(dir, 'tools', 'c2'), { recursive: true });
  writeFileSync(join(dir, 'tools', 'c2', 'scope.json'),
    JSON.stringify({ exercise: 'qa', targets: ['a.local'], window: { start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z' } }));
  try {
    for (const sub of ['scan', 'run']) {
      const r = runTool('c2-qa.py', [sub, '--payload', '/nonexistent/x.bin'], dir, false);
      assert.equal(r.status, 2, `c2-qa ${sub} 缺文件应 rc=2, 实得 ${r.status}`);
      assert.ok(!r.stderr.includes('Traceback'), '不得裸栈');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('c2-variant --families 未知/空族名 rc=2(CS53-NEW-A/D 锁)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fam-'));
  mkdirSync(join(dir, 'tools', 'c2'), { recursive: true });
  writeFileSync(join(dir, 'tools', 'c2', 'scope.json'),
    JSON.stringify({ exercise: 'qa', targets: ['a.local'], window: { start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z' } }));
  const payload = join(dir, 'p.php');
  writeFileSync(payload, '<?php // SPECTRE-MARK\n');
  try {
    for (const fams of ['totally-bogus', '', ',']) {
      const r = runTool('c2-variant.py', ['gen', '--src', payload, '--out', join(dir, 'o'), '--families', fams], dir, false);
      assert.equal(r.status, 2, `--families ${JSON.stringify(fams)} 应 rc=2, 实得 ${r.status}`);
      assert.ok(!r.stderr.includes('Traceback'), '不得裸栈');
    }
    // 转发面(c2-qa run)同拒
    const q = runTool('c2-qa.py', ['run', '--payload', payload, '--families', 'bogus'], dir, false);
    assert.equal(q.status, 2, `c2-qa run --families bogus 应 rc=2, 实得 ${q.status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('c2-variant --families 合法族接受态 rc=0(CS54-F3 锁)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fam-ok-'));
  mkdirSync(join(dir, 'tools', 'c2'), { recursive: true });
  writeFileSync(join(dir, 'tools', 'c2', 'scope.json'),
    JSON.stringify({ exercise: 'qa', targets: ['a.local'], window: { start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z' } }));
  const payload = join(dir, 'p.php');
  writeFileSync(payload, '<?php // SPECTRE-MARK\necho "SPECTRE-MARK";\n');
  try {
    const r = runTool('c2-variant.py', ['gen', '--src', payload, '--out', join(dir, 'o'), '--families', 'mask,decomp'], dir, false);
    assert.equal(r.status, 0, `合法族应 rc=0, 实得 ${r.status}\nstderr:${r.stderr?.slice(-200)}`);
    assert.ok(!r.stderr.includes('Traceback'), '不得裸栈');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phish 族畸形参+EDUSRC→76 门先(R32D74-N1 锁)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phish-gate-'));
  try {
    for (const [tool, args] of [
      ['phish-send.py', ['--bogus-arg']],
      ['phish-track.py', ['--bogus-arg']],
      ['phish-proxy.py', ['--bogus']],
      ['phishlet-proxy.py', ['--bogus']],
    ]) {
      const r = runTool(tool, args, dir, true);
      assert.equal(r.status, 76, `${tool} 畸形参+EDUSRC 应 76(门先于用法), 实得 ${r.status}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phish 族 -h+EDUSRC→0 帮助永先(CS55-F2 锁)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phish-h-'));
  try {
    for (const tool of ['phish-send.py', 'phish-track.py', 'phish-proxy.py', 'phishlet-proxy.py']) {
      const r = runTool(tool, ['-h'], dir, true);
      assert.equal(r.status, 0, `${tool} -h+EDUSRC 应 0(帮助永先), 实得 ${r.status}`);
      assert.ok(!r.stderr.includes('EDUSRC'), '不得先拒');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('-h 任意位=0 家族契约(CS59-F2/CS60-N2 锁: 六探针含 authmatrix)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anypos-h-'));
  try {
    const probe = { 'c2-variant.py': ['gen', '-h'], 'c2-qa.py': ['scan', '-h'], 'c2-javart.py': ['badmode', '-h'], 'toklab.py': ['badmode', '-h'], 'jsondiff.py': ['a.json', 'b.json', '-h'], 'authmatrix.py': ['plan.json', '-h'] };
    for (const [tool, argv] of Object.entries(probe)) {
      const r = runTool(tool, argv, dir, false);
      assert.equal(r.status, 0, `${tool} ${argv.join(' ')} 应 0(-h 任意位), 实得 ${r.status}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
