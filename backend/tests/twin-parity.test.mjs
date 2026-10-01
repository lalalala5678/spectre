/**
 * twin-parity (CS8-P0/CS9-N2/N14): 双胞胎副本一致性机锁。
 *
 * 约定:
 * - docs/*.py 权威, tools/bin/*.py 部署产物(tools-sync 交付);
 * - docs/<技能>/ 与 docs/<skills-root>/<技能>/ 的技能双胞胎逐字节一致;
 * - 双侧存在性纳入断言(N14: 任一侧被删即红, 无静默逃生道)。
 * 单侧编辑/删除任一侧 → 本测试红(AGENTS.md:67 的机器防线)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const EXPECTED_BIN_TWINS = [
  'c2-payload-spec.py', 'c2-qa.py', 'c2-variant.py', 'openapi-paths.py',
  'phish-proxy.py', 'phish-send.py', 'phish-track.py', 'phishlet-proxy.py',
  'spectre-arl.py', 'spectre-bloodhound.py', 'spectre-nuclei.py',
];

test('tools/bin ↔ docs: 期望清单内逐字节一致且双侧必须存在', () => {
  const drifted = [], missing = [];
  for (const f of EXPECTED_BIN_TWINS) {
    const a = join(ROOT, 'docs', f), b = join(ROOT, 'tools', 'bin', f);
    if (!existsSync(a) || !existsSync(b)) { missing.push(f); continue; }
    if (readFileSync(a, 'utf8') !== readFileSync(b, 'utf8')) drifted.push(f);
  }
  assert.deepEqual(missing, [], `双胞胎缺侧: ${missing.join(', ')}`);
  assert.deepEqual(drifted, [], `双胞胎漂移(docs 为权威): ${drifted.join(', ')}`);
});
// 技能双胞胎期望清单(CS9-N2: 全量 21 对枚举锁定——新增双胞胎须入表;
// skills-root 独有件(无顶层双胞胎)不受约, 删侧逃避因双侧存在性断言封死)。
const EXPECTED_SKILL_TWINS = [
  'brute-skills/nmap-cheatsheet',
  'nday-skills/cve-intel',
  'nday-skills/exploit-triage',
  'nday-skills/nday-report',
  'nday-skills/poc-adapt',
  'nday-skills/variant-bypass',
  'phish-skills/email-craft',
  'phish-skills/landing-page',
  'phish-skills/smtp-send',
  'phish-skills/track-report',
  'recon-skills/attribution-hunt',
  'recon-skills/cdn-bypass',
  'recon-skills/cidr-decision',
  'recon-skills/host-profile',
  'recon-skills/nmap-cheatsheet',
  'recon-skills/osint-dork',
  'recon-skills/pi-discovery',
  'recon-skills/recon-report',
  'recon-skills/subdomain-sweep',
  'recon-skills/vhost-collide',
  'recon-skills/web-topology',
];

test('技能双胞胎全量一致(期望清单, 双侧必须存在)', () => {
  const drifted = [], missing = [];
  for (const t of EXPECTED_SKILL_TWINS) {
    const [root, name] = t.split('/');
    const a = join(ROOT, 'docs', name, 'SKILL.md');
    const b = join(ROOT, 'docs', root, name, 'SKILL.md');
    if (!existsSync(a) || !existsSync(b)) { missing.push(t); continue; }
    if (readFileSync(a, 'utf8') !== readFileSync(b, 'utf8')) drifted.push(t);
  }
  assert.deepEqual(missing, [], `技能双胞胎缺侧: ${missing.join(', ')}`);
  assert.deepEqual(drifted, [], `技能双胞胎漂移: ${drifted.join(', ')}`);
});
