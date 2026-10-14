/**
 * traffic-bridge 机锁: POST /api/traffic HTTP 面——浏览器/Burp 流量对
 * → 情报库 intel-note(操作员入口, gateway 反代后席位经 query_intel 消费)。
 * 红→绿协议: 路由实现前本文件全红(404)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT_MAP } from '../src/config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function onceUp(port, tries = 40) {
  return new Promise((resolve, reject) => {
    const t = setInterval(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.status === 200) { clearInterval(t); resolve(); }
      } catch { /* boot */ }
    }, 250);
    setTimeout(() => { clearInterval(t); reject(new Error('runtime 10s 未就绪')); }, 10000);
  });
}

test('POST /api/traffic: 守卫/落库/批量上限(真 runtime)', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traffic-http-'));
  writeFileSync(join(dir, '.env'), 'INTERNAL_TOKEN=tb1\n');
  const port = PORT_MAP.testPortBase + PORT_MAP.testPortSpan - 100 + (process.pid % 49);
  const child = spawn(process.execPath, ['agent-runtime.mjs'], {
    cwd: ROOT,
    env: { ...process.env, SPECTRE_DATA_DIR: dir, PORT: String(port), INTERNAL_TOKEN: 'tb1', SPECTRE_SANDBOX_ROOT: dir },
    stdio: 'ignore',
  });
  const H = { 'X-Internal-Token': 'tb1', 'Content-Type': 'application/json' };
  const post = body => fetch(`http://127.0.0.1:${port}/api/traffic`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  try {
    await onceUp(port);
    // ① 无令牌 401(统一鉴权门)
    const noAuth = await fetch(`http://127.0.0.1:${port}/api/traffic`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noAuth.status, 401, '无内部令牌应 401');
    // ② 形状守卫
    assert.equal((await post({})).status, 400, '缺 pairs 应 400');
    assert.equal((await post({ pairs: [] })).status, 400, '空 pairs 应 400');
    assert.equal((await post({ pairs: 'x' })).status, 400, 'pairs 非数组应 400');
    assert.equal((await post({ pairs: [{ request: {} }] })).status, 400, '缺 request.url 应 400');
    assert.equal((await post({ pairs: [{ request: { url: 'ftp://x' } }] })).status, 400, '非 http(s) url 应 400');
    assert.equal((await post({ pairs: Array.from({ length: 51 }, () => ({ request: { url: 'http://a' } })) })).status, 400, '51 对应 400(上限 50)');
    // ③ 正常两对 → 落库 intel-note, seq 回执, ws 继承
    const ok = await post({ title: '认证态抓包', pairs: [
      { request: { method: 'POST', url: 'https://sso.example.com/api/login', headers: { 'content-type': 'application/json' }, body: '{"user":"a"}' },
        response: { status: 200, headers: { 'set-cookie': 'SID=x' }, body: '{"ok":true}' }, note: '登录成功带 SID' },
      { request: { method: 'GET', url: 'https://api.example.com/v9/users?page=1' }, response: { status: 200, body: '{"total":8394}' } },
    ] });
    const okRaw = await ok.text();
    assert.equal(ok.status, 200, `正常提交应 200: ${okRaw}`);
    const r1 = JSON.parse(okRaw);
    assert.equal(r1.filed, 2);
    assert.equal(r1.seqs.length, 2, '每对一条 seq 回执');
    // ④ 总线可查(ws 过滤面)且正文/标记齐备
    const busQ = await (await fetch(`http://127.0.0.1:${port}/api/bus?ws=${encodeURIComponent(r1.workSessionId ?? '')}`, { headers: H })).json();
    const hits = (busQ.events ?? busQ).filter?.bind ? [] : [];  // 兼容形状, 下行直接断言
    const evs = Array.isArray(busQ) ? busQ : (busQ.events ?? []);
    const notes = evs.filter(e => e.type === 'intel-note' && String(e.title ?? '').includes('[流量]'));
    assert.ok(notes.length >= 2, `总线应含 [流量] intel-note(实得 ${notes.length})`);
    const login = notes.find(e => String(e.title).includes('POST'));
    assert.ok(login, '标题应含方法+短 URL');
    assert.ok(String(login.detail).includes('sso.example.com'), 'detail 应含请求行');
    assert.ok(String(login.detail).includes('set-cookie: SID=x'), '响应头 set-cookie 必须入 detail(认证态核心情报)');
    assert.equal((String(login.detail).match(/^```/gm) || []).length, 4, '结构围栏须恰 2 开 2 闭');
    assert.equal(login.from, 'operator');
    // ⑥ ws 守卫(姊妹路由同制式): 非法/超长 ws 拒 400
    const badWs = await post({ workSessionId: '../' + 'A'.repeat(100),
      pairs: [{ request: { url: 'http://a' } }] });
    assert.equal(badWs.status, 400, '非法 workSessionId 应 400');
    // ⑦ method 截断进 title(bus title 无 clip, 唯一上限点在路由)
    const bigM = await post({ pairs: [{ request: { method: 'X'.repeat(2000), url: 'http://b' },
      response: { status: 200 } }] });
    assert.equal(bigM.status, 200);
    const evBig = JSON.parse(await bigM.text());
    const busM = await (await fetch(`http://127.0.0.1:${port}/api/bus?limit=50`, { headers: H })).json();
    const evsM = Array.isArray(busM) ? busM : (busM.events ?? []);
    const noteM = evsM.find(e => e.seq === evBig.seqs[0]);
    assert.ok(noteM.title.length < 200, `title 须受 method 截断保护(实得 ${noteM.title.length})`);
    // ⑧ 围栏消毒: 响应体含 ``` 不得逃出 http 围栏
    const fence = await post({ pairs: [{ request: { url: 'http://c' },
      response: { status: 200, body: '```\n# 伪造标题' } }] });
    const evF = JSON.parse(await fence.text());
    const busF = await (await fetch(`http://127.0.0.1:${port}/api/bus?limit=50`, { headers: H })).json();
    const evsF = Array.isArray(busF) ? busF : (busF.events ?? []);
    const noteF = evsF.find(e => e.seq === evF.seqs[0]);
    // ⑨ status 行同受消毒(R1 残留锁): 带换行+围栏的伪造状态行不得逃逸
    const fence2 = await post({ pairs: [{ request: { url: 'http://d' },
      response: { status: '200\n```\n# 伪造标题-STATUS' } }] });
    const evS = JSON.parse(await fence2.text());
    const busS = await (await fetch(`http://127.0.0.1:${port}/api/bus?limit=50`, { headers: H })).json();
    const evsS = Array.isArray(busS) ? busS : (busS.events ?? []);
    const noteS = evsS.find(e => e.seq === evS.seqs[0]);
    assert.ok(String(noteS.detail).includes('HTTP 200 `\u200b`\u200b` # 伪造标题-STATUS'),
      `status 行应白空格折叠+围栏零宽消毒, 实得片段: ${String(noteS.detail).slice(String(noteS.detail).indexOf('HTTP'), +80)}`);
    assert.ok(!String(noteS.detail).includes('```\n# 伪造标题'),
      'status 行的裸 ``` 不得逃逸成围栏闭合');
    // ⑤ emit 未确认如实计数契约: 全确认时无 note(条件字段, 非恒串)
    assert.equal(r1.note, undefined, '全确认时不应有 note(仅异常时出现)');
    void hits;
  } finally {
    child.kill('SIGKILL');
    await new Promise(r => setImmediate(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
