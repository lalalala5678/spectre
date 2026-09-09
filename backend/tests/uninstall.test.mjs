import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

// Isolated sandbox root BEFORE importing container.mjs (HOST is derived
// from SPECTRE_SANDBOX_ROOT at module load).
process.env.SPECTRE_SANDBOX_ROOT = '/tmp/spectre-sbx-test';
const { uninstallCliTool, removeInstallLogEntries } = await import(
  '../src/sandbox/container.mjs');

const TOOLS = '/tmp/spectre-sbx-test/tools';
const rmAll = () => fsp.rm('/tmp/spectre-sbx-test', { recursive: true, force: true });

test('uninstall_cli removes binary + pip dist-info + npm layout + log', async () => {
  await rmAll();
  // fake installs: bare binary, pip package + versioned dist-info,
  // npm node_modules + bin link, one install-log line each
  await fsp.mkdir(`${TOOLS}/bin`, { recursive: true });
  await fsp.mkdir(`${TOOLS}/py/httpx/httpx`, { recursive: true });
  await fsp.mkdir(`${TOOLS}/py/httpx-httpx-1.2.3.dist-info`, { recursive: true });
  await fsp.mkdir(`${TOOLS}/py/other-pkg`, { recursive: true }); // sibling — must survive
  await fsp.mkdir(`${TOOLS}/npm-global/lib/node_modules/httpx`, { recursive: true });
  await fsp.mkdir(`${TOOLS}/npm-global/bin`, { recursive: true });
  await fsp.writeFile(`${TOOLS}/bin/httpx`, '#!/bin/sh', 'utf8');
  await fsp.writeFile(`${TOOLS}/npm-global/bin/httpx`, '#!/bin/sh', 'utf8');
  await fsp.writeFile(`${TOOLS}/install-log`,
    '2026-01-01T00:00:00Z\tpip install --target /opt/tools/py httpx\n'
    + '2026-01-02T00:00:00Z\tnpm --prefix /opt/tools/npm-global install -g httpx\n'
    + '2026-01-03T00:00:00Z\tapt-get install -y keepme\n', 'utf8');

  const r = await uninstallCliTool('httpx');

  // all three layouts removed
  assert.equal(r.removed.filter(p => p.includes('httpx')).length, 5,
    `expected 5 httpx paths removed, got: ${r.removed.join(',')}`);
  // log: both httpx lines gone, unrelated entry kept
  assert.equal(r.clearedLog.length, 2);
  const log = await fsp.readFile(`${TOOLS}/install-log`, 'utf8');
  assert.ok(!log.includes('httpx'));
  assert.ok(log.includes('keepme'));
  // sibling pip package untouched
  await assert.rejects(() => fsp.stat(`${TOOLS}/py/other-pkg/httpx`));
  await fsp.stat(`${TOOLS}/py/other-pkg`);

  await rmAll();
});

test('uninstall of an unknown name is a clean no-op', async () => {
  await rmAll();
  await fsp.mkdir(TOOLS, { recursive: true });
  const r = await uninstallCliTool('nonexistent-tool');
  assert.deepEqual(r, { removed: [], clearedLog: [] });
  await rmAll();
});

test('invalid names are rejected (path-safety)', async () => {
  await assert.rejects(() => uninstallCliTool('../etc'), /invalid tool name/);
  await assert.rejects(() => uninstallCliTool('x; rm -rf'), /invalid tool name/);
});

test('removeInstallLogEntries tolerates a missing log file', async () => {
  await rmAll();
  await fsp.mkdir(TOOLS, { recursive: true });
  assert.deepEqual(await removeInstallLogEntries('anything'), []);
  await rmAll();
});
