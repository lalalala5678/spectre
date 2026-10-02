/** CS80-1(P1) 行为锁: read_session sessionId 三路——裸 ID(sess-...)
 * 原样、payloadRef(sess:sess-...)仅剥 sess: 段、EB 过剥形不得复生。
 * 背景: 会话 ID 本体即 "sess-" 开头(sessions.mjs id=`sess-${...}`),
 * 双收版 replace(/^sess[:-]/) 把裸 ID 前缀吞掉致 store.get 必败。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('read_session: 裸 ID 原样/payloadRef 仅剥 sess: 段(CS80-1 锁)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-pfx-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  process.env.SPECTRE_DATA_DIR = dir;
  process.env.INTERNAL_TOKEN ||= 'rs-test';
  process.env.TEMPORAL_ADDRESS ||= '127.0.0.1:7233';
  const prevCwd = process.cwd();
  process.chdir(join(ROOT, 'backend'));
  try {
    const { buildIntelTools } = await import('../src/tools.mjs');
    const seen = [];
    const caps = { readSessionMessages: (sid, _last, _ws) => { seen.push(sid); return [{ role: 'assistant', text: `ok:${sid}` }]; } };
    const rec = { id: 'sess-call', agentKey: 'recon', workSessionId: 'ws' };
    const read = buildIntelTools(rec, caps).find(t => t.name === 'read_session');
    assert.ok(read, 'read_session 在 buildIntelTools 面');
    // ① 裸 ID(sess-abc)——原样, 不得剥
    let r = await read.execute('t', { sessionId: 'sess-abc' });
    assert.equal(seen.at(-1), 'sess-abc', `裸 ID 须原样, 实得 ${seen.at(-1)}`);
    assert.ok(r.content[0].text.includes('ok:sess-abc'));
    // ② payloadRef(sess:sess-abc)——仅剥 'sess:' 段
    r = await read.execute('t', { sessionId: 'sess:sess-abc' });
    assert.equal(seen.at(-1), 'sess-abc', `payloadRef 仅剥 sess: 段, 实得 ${seen.at(-1)}`);
    // ③ EB 过剥形(裸 ID 被吞前缀)不得复生
    r = await read.execute('t', { sessionId: 'sess-abc' });
    assert.notEqual(seen.at(-1), 'abc', '过剥形复生');
  } finally {
    process.chdir(prevCwd);
    delete process.env.SPECTRE_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
