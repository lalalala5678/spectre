/**
 * beacon transport 机锁(P0 切片): shells.mjs 第四种通道的操作员侧契约。
 *
 * 红→绿协议: 本文件先于实现落仓——register 校验/exec 回传/超时语义/
 * 未知通道兜底四面前置断言(写时全红), 实现合入后全绿。fake listener
 * 为协议一致性桩(与 deploy/beacon-listener.py 同协议), 不跨语言起
 * python——listener 本体的冒烟由 deploy 侧手工路径覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKEND = join(ROOT, 'backend');

/** 子进程跑一段模块脚本(隔离 shells.mjs 的 import 期 SPECTRE_DATA_DIR)。 */
function run(script, { timeout = 30000 } = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: script, encoding: 'utf8', timeout, cwd: BACKEND,
  });
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** in-child fake listener: 单 shell 协议桩。modes: ok(2 拍后回传)/hang(恒 pending)。 */
const FAKE_LISTENER_SRC = `
import http from 'node:http';
export function startFake(mode) {
  let polls = 0;
  const srv = http.createServer((req, res) => {
    const body = (chunks => chunks)([]);
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => {
      const j = buf ? JSON.parse(buf) : {};
      const send = (code, obj) => { const b = JSON.stringify(obj ?? {});
        res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length }); res.end(b); };
      if (req.method === 'POST' && req.url.startsWith('/op/')) return send(200, { id: 't1' });
      if (req.method === 'GET' && req.url.startsWith('/op/')) {
        polls++;
        if (mode === 'ok' && polls >= 2) return send(200, { id: 't1', stdout: 'BEACON-OUT', stderr: '', code: 0, ms: 1234 });
        return send(202, { ok: false, error: 'pending' });
      }
      send(404, {});
    });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}
`;

test('register: beacon transportRef 非法 URL 拒绝且文案可行动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-reg-'));
  try {
    const out = run(`
process.env.SPECTRE_DATA_DIR = ${JSON.stringify(dir)};
const { createShellRegistry } = await import('./src/shells.mjs');
const reg = createShellRegistry({ bus: { emit(){} }, listScope: () => null });
const bad = reg.register({ transport: 'beacon', transportRef: 'not-a-url',
  target: 't1', name: 'b1', createdBy: 'test' });
const ok = reg.register({ transport: 'beacon', transportRef: 'http://127.0.0.1:19997',
  target: 't1', name: 'b2', createdBy: 'test' });
console.log(JSON.stringify({ badErr: bad?.error ?? null, okId: ok?.id ?? null, okStatus: ok?.status ?? null }));
`);
    assert.match(out.badErr, /beacon transportRef/, `非法 URL 应被拒并给出格式指引, 实得: ${out.badErr}`);
    assert.ok(out.okId && out.okStatus === 'active', '合法 URL 应注册成功且 active');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('exec: 任务入队→轮询→回传 roundtrip(stdout/code/审计)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-exec-'));
  try {
    const out = run(`
process.env.SPECTRE_DATA_DIR = ${JSON.stringify(dir)};
${FAKE_LISTENER_SRC}
const srv = await startFake('ok');
const port = srv.address().port;
const { createShellRegistry } = await import('./src/shells.mjs');
const busEvents = [];
const reg = createShellRegistry({ bus: { emit: (t, p) => busEvents.push(JSON.stringify(p ?? t)) }, listScope: () => null });
const sh = reg.register({ transport: 'beacon', transportRef: 'http://127.0.0.1:' + port,
  target: 'lab-box', name: 'b-e2e', createdBy: 'test' });
const r = await reg.exec(sh.id, 'echo marker', { timeoutMs: 5000 });
srv.close();
console.log(JSON.stringify({ ok: r.ok, stdout: r.stdout, code: r.code,
  err: r.error ?? null, audited: busEvents.some(t => String(t).includes('shell-exec')) }));
`, { timeout: 40000 });
    assert.ok(out.ok, `beacon exec 应成功回传, 实得: ${out.err}`);
    assert.equal(out.stdout, 'BEACON-OUT');
    assert.equal(out.code, 0);
    assert.ok(out.audited, 'exec 必须进审计(shell-exec 事件)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('exec: 超时=会话未回传的如实失败(不伪造成功)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-hang-'));
  try {
    const out = run(`
process.env.SPECTRE_DATA_DIR = ${JSON.stringify(dir)};
${FAKE_LISTENER_SRC}
const srv = await startFake('hang');
const port = srv.address().port;
const { createShellRegistry } = await import('./src/shells.mjs');
const reg = createShellRegistry({ bus: { emit(){} }, listScope: () => null });
const sh = reg.register({ transport: 'beacon', transportRef: 'http://127.0.0.1:' + port,
  target: 'lab-box', name: 'b-hang', createdBy: 'test' });
const t0 = Date.now();
const r = await reg.exec(sh.id, 'sleep 999', { timeoutMs: 1200 });
srv.close();
console.log(JSON.stringify({ ok: r.ok, err: r.error ?? null, ms: Date.now() - t0 }));
`, { timeout: 40000 });
    assert.ok(!out.ok, '无回传不得报成功');
    assert.match(out.err, /未回传|未接入/, `超时文案应可行动(探活指引), 实得: ${out.err}`);
    assert.ok(out.ms < 15000, `超时应受 deadline 约束(实测 ${out.ms}ms)`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('exec: 未知通道仍走"未接入"兜底(回归)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-unk-'));
  try {
    const out = run(`
process.env.SPECTRE_DATA_DIR = ${JSON.stringify(dir)};
const { createShellRegistry } = await import('./src/shells.mjs');
const reg = createShellRegistry({ bus: { emit(){} }, listScope: () => null });
const sh = reg.register({ transport: 'dns', transportRef: 'whatever',
  target: 't', name: 'dns-x', createdBy: 'test' });
const r = await reg.exec(sh.id, 'id');
console.log(JSON.stringify({ ok: r.ok, err: r.error ?? null }));
`);
    assert.ok(!out.ok);
    assert.match(out.err, /未接入/, `未知 transport 兜底分支必须保留, 实得: ${out.err}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('快照持久化: beacon 通道重启回放(同 OOB/既有通道契约)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-snap-'));
  try {
    const regScript = (phase) => `
process.env.SPECTRE_DATA_DIR = ${JSON.stringify(dir)};
const { createShellRegistry } = await import('./src/shells.mjs');
${phase === 'a' ? `
const reg = createShellRegistry({ bus: { emit(){} }, listScope: () => null });
const sh = reg.register({ transport: 'beacon', transportRef: 'http://10.0.0.5:19997',
  target: 'dmz-box', name: 'b-snap', createdBy: 'test' });
console.log(JSON.stringify({ id: sh.id, ok: Boolean(sh.id) }));` : `
const reg = createShellRegistry({ bus: { emit(){} }, listScope: () => null });
const all = reg.list({ transport: 'beacon' });
console.log(JSON.stringify({ id: all[0]?.id ?? null, n: all.length,
  ref: all[0]?.transportRef ?? null }));`}
`;
    const a = run(regScript('a'));
    const b = run(regScript('b'));
    assert.ok(a.ok && b.id === a.id, `重放应恢复同 id 通道(${a.id} → ${b.id})`);
    assert.equal(b.n, 1);
    assert.equal(b.ref, 'http://10.0.0.5:19997');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('register 归一化对称: 尾空白/斜杠剥离后持久化(exec 不再 ERR_INVALID_URL)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-norm-'));
  try {
    const out = run(`
process.env.SPECTRE_DATA_DIR = ${JSON.stringify(dir)};
${FAKE_LISTENER_SRC}
const srv = await startFake('ok');
const port = srv.address().port;
const { createShellRegistry } = await import('./src/shells.mjs');
const reg = createShellRegistry({ bus: { emit(){} }, listScope: () => null });
const sh = reg.register({ transport: 'beacon', transportRef: 'http://127.0.0.1:' + port + '/  ',
  target: 't', name: 'b-norm', createdBy: 'test' });
const r = await reg.exec(sh.id, 'echo x', { timeoutMs: 5000 });
srv.close();
console.log(JSON.stringify({ ref: sh.transportRef, ok: r.ok, err: r.error ?? null }));
`, { timeout: 40000 });
    assert.match(out.ref, /^http:\/\/127\.0\.0\.1:\d+$/, `持久化须为归一化基址(无尾斜杠/空白), 实得: ${JSON.stringify(out.ref)}`);
    assert.ok(!/ERR_INVALID_URL/.test(out.err ?? ''), `归一化后 exec 不应再报 URL 错误, 实得: ${out.err}`);
    assert.ok(out.ok, 'exec 应成功');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('上限常量锁: BEACON_EXEC_MAX_MS=120s 且 exec 实际消费它', () => {
  const src = readFileSync(join(BACKEND, 'src/shells.mjs'), 'utf8');
  assert.ok(src.includes('export const BEACON_EXEC_MAX_MS = 120_000'), '上限须以导出常量单源存在');
  assert.ok(src.includes('Math.min(timeoutMs, BEACON_EXEC_MAX_MS)'), 'exec 须消费该常量(突变实验封堵面)');
});

test('超时路径审计零盲区: timeoutPending 任务史+bus 事件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-audit-'));
  try {
    const out = run(`
process.env.SPECTRE_DATA_DIR = ${JSON.stringify(dir)};
${FAKE_LISTENER_SRC}
const srv = await startFake('hang');
const port = srv.address().port;
const { createShellRegistry } = await import('./src/shells.mjs');
const busEvents = [];
const reg = createShellRegistry({ bus: { emit: (t, p) => busEvents.push(JSON.stringify(p ?? t)) }, listScope: () => null });
const sh = reg.register({ transport: 'beacon', transportRef: 'http://127.0.0.1:' + port,
  target: 't', name: 'b-audit', createdBy: 'test' });
const r = await reg.exec(sh.id, 'sleep 999', { timeoutMs: 1200 });
srv.close();
const g = reg.get(sh.id);
console.log(JSON.stringify({ ok: r.ok,
  task: (g.tasks ?? []).find(x => x.timeoutPending) ?? null,
  audited: busEvents.some(s => s.includes('shell-exec') && s.includes('timeoutPending')) }));
`, { timeout: 40000 });
    assert.ok(!out.ok);
    assert.ok(out.task, '超时命令必须进任务史(timeoutPending 标记)');
    assert.ok(out.audited, '超时命令必须产生 shell-exec 审计事件');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('真 listener 协议锁: python 实弹(204 无 body/code 防御/16 并发入队零丢失)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-live-'));
  const port = 20000 + Math.floor(Math.random() * 8000);
  let py = null;
  try {
    py = spawn('python3', [join(ROOT, 'deploy/beacon-listener.py')], {
      env: { ...process.env, SPECTRE_DATA_DIR: dir, BEACON_PORT: String(port) },
      stdio: 'ignore', detached: false,
    });
    const base = `http://127.0.0.1:${port}`;
    // ready 轮询(/health)
    let up = false;
    for (let i = 0; i < 20 && !up; i++) {
      await new Promise(r => setTimeout(r, 300));
      try { up = (await fetch(`${base}/health`)).ok; } catch { /* boot 中 */ }
    }
    assert.ok(up, 'listener 未在 6s 内就绪');
    const sid = 'sh-livetest01';
    // ① 入队 → beacon 取任务(未 result 前重复可取) → 坏 code 400 → 好 code 回传 → op 查询
    const enq = await (await fetch(`${base}/op/${sid}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'echo live' }) })).json();
    const t1 = await (await fetch(`${base}/task/${sid}`)).json();
    const t2 = await (await fetch(`${base}/task/${sid}`)).json();
    assert.equal(t1.id, enq.id);
    assert.equal(t2.id, enq.id, '未 result 前任务须可重复领取(崩溃恢复语义)');
    const badR = await fetch(`${base}/result/${sid}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: enq.id, stdout: '', code: 'exit-1' }) });
    assert.equal(badR.status, 400, '非整数 code 必须 400 而非崩溃断连');
    await fetch(`${base}/result/${sid}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: enq.id, stdout: 'live-out', code: 7 }) });
    const got = await (await fetch(`${base}/op/${sid}?id=${enq.id}`)).json();
    assert.equal(got.stdout, 'live-out');
    assert.equal(got.code, 7);
    // ② 空任务 204 无 body(keep-alive 安全)
    const none = await fetch(`${base}/task/${sid}`);
    assert.equal(none.status, 204);
    assert.equal((await none.text()).length, 0, '204 不得携带 body');
    // ③ 16 并发入队计数守恒(per-sid 锁)
    const sid2 = 'sh-liverace99';
    const rs = await Promise.all(Array.from({ length: 16 }, () =>
      fetch(`${base}/op/${sid2}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'x' }) })));
    assert.ok(rs.every(r => r.status === 200), '16 连发应全部入队成功(未满)');
    let n = 0;
    for (;;) {
      const r = await fetch(`${base}/task/${sid2}`);
      if (r.status === 204) break;
      const t = await r.json();
      await fetch(`${base}/result/${sid2}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: t.id, stdout: '', code: 0 }) });
      n++;
    }
    assert.equal(n, 16, `并发入队须零丢失(实收 ${n}/16)`);
  } finally {
    if (py) try { process.kill(py.pid, 'SIGKILL'); } catch { /* 已退 */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('413/畸形 CL 弃连: 超限 body 后服务端必须关连接(keep-alive 不被残留毒化)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-413-'));
  const port = 20000 + Math.floor(Math.random() * 8000);
  let py = null;
  try {
    py = spawn('python3', [join(ROOT, 'deploy/beacon-listener.py')], {
      env: { ...process.env, SPECTRE_DATA_DIR: dir, BEACON_PORT: String(port) },
      stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 20 && !up; i++) {
      await new Promise(r => setTimeout(r, 300));
      try { up = (await fetch(`${base}/health`)).ok; } catch { /* boot 中 */ }
    }
    assert.ok(up, 'listener 未就绪');
    const net = await import('node:net');
    const probe = (raw) => new Promise((resolve, reject) => {
      const s = net.createConnection({ host: '127.0.0.1', port }, () => s.write(raw));
      let buf = '';
      s.on('data', d => { buf += d; });
      s.on('close', () => resolve({ buf, closed: true }));
      s.on('error', reject);
      setTimeout(() => { s.destroy(); resolve({ buf, closed: false }); }, 8000);
    });
    // ① 超限 CL: 413 + 服务端弃连(EOF)
    const r1 = await probe(
      `POST /op/sh-x413 HTTP/1.1\r\nHost: t\r\nContent-Length: ${1 << 21}\r\n\r\n`);
    assert.match(r1.buf, /413/, `超限 body 应回 413, 实得: ${r1.buf.slice(0, 60)}`);
    assert.ok(r1.closed, '413 后服务端必须关连接(未排空残留 body)');
    // ② 畸形 CL: 400 + 弃连(不 crash 断连)
    const r2 = await probe(
      'POST /op/sh-x413 HTTP/1.1\r\nHost: t\r\nContent-Length: abc\r\n\r\n');
    assert.match(r2.buf, /400/, `畸形 Content-Length 应回 400, 实得: ${r2.buf.slice(0, 60)}`);
    assert.ok(r2.closed, '畸形 CL 后服务端必须关连接');
    // ③ 未知路由 POST 带 body: 404 也必须弃连+显式 Connection: close(同族守卫)
    const r3 = await probe(
      'POST /nope/sh-x413 HTTP/1.1\r\nHost: t\r\nContent-Length: 8\r\n\r\nAAAAAAAA');
    assert.match(r3.buf, /404/, `未知路由应回 404, 实得: ${r3.buf.slice(0, 60)}`);
    assert.ok(r3.closed, '未知路由(带未读 body)的 404 必须关连接');
    assert.match(r3.buf, /Connection:\s*close/i, '弃连响应应带显式 Connection: close 头');
    // ④ 服务未被前三发打死
    const h = await fetch(`${base}/health`);
    assert.ok(h.ok, '异常请求后 listener 必须仍存活');
  } finally {
    if (py) try { process.kill(py.pid, 'SIGKILL'); } catch { /* 已退 */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
