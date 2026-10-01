/**
 * twin-parity (CS8-P0): 双胞胎副本一致性机锁。
 *
 * 约定: docs/*.py 是唯一权威源, tools/bin/*.py 是部署产物
 * (deploy/tools-sync.sh 从 tools/bin 复制到数据根)。docs/*-skills/
 * 的技能双胞胎以 skills-seed 实际部署份为准做逐字节 parity。
 * 任一侧单边编辑即红——AGENTS.md:67 "全仓 grep 引用一次同步"的
 * 机器防线(此前 10 对 .py 双胞胎 4 对漂移、修复落在非运行位副本)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('tools/bin ↔ docs: 全部共有 .py 双胞胎逐字节一致(docs 为权威源)', () => {
  const bin = join(ROOT, 'tools', 'bin');
  const drifted = [];
  for (const f of readdirSync(bin)) {
    if (!f.endsWith('.py')) continue;
    const docsCopy = join(ROOT, 'docs', f);
    if (!existsSync(docsCopy)) continue;  // 独立件(无 docs 版)不在此约
    if (readFileSync(join(bin, f), 'utf8') !== readFileSync(docsCopy, 'utf8')) {
      drifted.push(f);
    }
  }
  assert.deepEqual(drifted, [],
    `双胞胎漂移(以 docs/ 为权威同步 tools/bin/): ${drifted.join(', ')}`);
});

test('cve-intel 技能双胞胎一致(部署份=docs/nday-skills)', () => {
  const a = join(ROOT, 'docs', 'cve-intel', 'SKILL.md');
  const b = join(ROOT, 'docs', 'nday-skills', 'cve-intel', 'SKILL.md');
  if (!existsSync(a) || !existsSync(b)) return;  // 结构变化时本测自然失效
  assert.equal(readFileSync(a, 'utf8'), readFileSync(b, 'utf8'),
    'docs/cve-intel 与 docs/nday-skills/cve-intel 漂移(nvd_cve 指导块曾单侧缺)');
});
