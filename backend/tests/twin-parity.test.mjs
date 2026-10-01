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
// 技能双胞胎期望清单(CS10-2: 全量 45 对枚举锁定(8 个 skills-root 全扫)——
// 新增双胞胎须入表;
// skills-root 独有件(无顶层双胞胎)不受约, 删侧逃避因双侧存在性断言封死)。
const EXPECTED_SKILL_TWINS = [
  'api-skills/api-inject',
  'api-skills/api-logic',
  'api-skills/api-mapping',
  'api-skills/api-replay',
  'api-skills/auth-matrix',
  'api-skills/idor-hunt',
  'api-skills/pdf-skill',
  'brute-skills/nmap-cheatsheet',
  'c2-skills/accept-gate',
  'c2-skills/payload-gen',
  'c2-skills/qa-loop',
  'c2-skills/scope-gate',
  'c2-skills/variant-engine',
  'nday-skills/cve-intel',
  'nday-skills/exploit-triage',
  'nday-skills/nday-report',
  'nday-skills/poc-adapt',
  'nday-skills/variant-bypass',
  'new-skills/asset-db',
  'new-skills/bloodhound-ad',
  'new-skills/exploit-triage',
  'new-skills/openapi-recon',
  'new-skills/payload-spec',
  'new-skills/phishlet',
  'new-skills/semgrep-scan',
  'new-skills/spectre-nuclei',
  'phish-skills/email-craft',
  'phish-skills/landing-page',
  'phish-skills/smtp-send',
  'phish-skills/track-report',
  'postex-skills/file-ops',
  'postex-skills/host-recon',
  'postex-skills/lateral-prep',
  'postex-skills/priv-enum',
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

test('docs/*.py 跨文件内容查重(CS11-1/2 盲区封堵: 粘贴覆写事故)', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = join(ROOT, 'docs');
  const files = readdirSync(dir).filter(f => f.endsWith('.py'));
  const nearDup = [];
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const a = readFileSync(join(dir, files[i]), 'utf8');
      const b = readFileSync(join(dir, files[j]), 'utf8');
      if (a === b) { nearDup.push(`${files[i]}≡${files[j]}`); continue; }
      const la = a.split('\n'), lb = b.split('\n');
      if (Math.abs(la.length - lb.length) > 5) continue;
      let same = 0;
      const n = Math.min(la.length, lb.length);
      for (let k = 0; k < n; k++) if (la[k] === lb[k]) same++;
      if (same / n > 0.9) nearDup.push(`${files[i]}≈${files[j]}(${Math.round(same/n*100)}%)`);
    }
  }
  assert.deepEqual(nearDup, [],
    `docs/*.py 存在近全同文件对(粘贴覆写事故特征): ${nearDup.join(', ')}`);
});

test('技能双胞胎清单=磁盘运行时枚举集合相等(CS11-7: 新增对逃逸封堵)', async () => {
  const { existsSync, readdirSync } = await import('node:fs');
  const SKILL_ROOTS = ['nday-skills', 'recon-skills', 'phish-skills',
    'brute-skills', 'api-skills', 'c2-skills', 'new-skills', 'postex-skills'];
  const onDisk = new Set();
  for (const root of SKILL_ROOTS) {
    const rdir = join(ROOT, 'docs', root);
    if (!existsSync(rdir)) continue;
    for (const name of readdirSync(rdir)) {
      const a = join(ROOT, 'docs', name, 'SKILL.md');
      const b = join(rdir, name, 'SKILL.md');
      if (existsSync(a) && existsSync(b)) onDisk.add(`${root}/${name}`);
    }
  }
  const listed = new Set(EXPECTED_SKILL_TWINS);
  const notListed = [...onDisk].filter(t => !listed.has(t));
  const dangling = [...listed].filter(t => !onDisk.has(t));
  assert.deepEqual(notListed, [],
    `磁盘新增双胞胎未入清单(须登记): ${notListed.join(', ')}`);
  assert.deepEqual(dangling, [],
    `清单悬空(双胞胎被删须同步清单): ${dangling.join(', ')}`);
});
