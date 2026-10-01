/**
 * py-semantics (CS15-Q5): docs/*.py 工具语义可执行机锁。
 *
 * 背景: spectre-nuclei 的 matcher 语义连续四批回归(CS12-N2 DNS 未定义
 * 名→CS13-1 误改 HTTP→CS14-2/3 丢 internal 过滤+早退→R32D42-P1 捕获跳
 * 当命中→CS15-5 or 占位 FP)。twin-parity 只做字节比对, 语义面零覆盖;
 * 本测试用 python3 子进程跑真实模块函数, 逐条锁死历史回归形状。
 * 改 docs/spectre-nuclei.py 的 matcher/链语义 → 对应用例红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NUCLEI = join(ROOT, 'docs', 'spectre-nuclei.py');

/** 跑一段 python 代码(以 sn 模块加载 spectre-nuclei), 返回其 JSON 输出。
 * 可选 server 为 true 时先起本地 HTTP 靶机(/hop1 含 alpha, 其余含
 * nothing-here), expr 可引用 base 与 base2 变量。 */
function py(expr, { server = false } = {}) {
  const lines = [
    'import json, sys, importlib.util, threading, http.server',
    `spec = importlib.util.spec_from_file_location('sn', ${JSON.stringify(NUCLEI)})`,
    'sn = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(sn)',
  ];
  if (server) {
    lines.push(
      'class _H(http.server.BaseHTTPRequestHandler):',
      '    def do_GET(self):',
      "        body = b'alpha-release' if self.path == '/hop1' else b'nothing-here'",
      '        self.send_response(200); self.send_header("Content-Type","text/plain")',
      '        self.end_headers(); self.wfile.write(body)',
      '    def log_message(self, *a): pass',
      '_srv = http.server.HTTPServer(("127.0.0.1", 0), _H)',
      'threading.Thread(target=_srv.serve_forever, daemon=True).start()',
      'base = f"http://127.0.0.1:{_srv.server_address[1]}"',
    );
  }
  lines.push(`print(json.dumps(${expr}))`);
  const r = spawnSync('python3', ['-'], { input: lines.join('\n'), encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) throw new Error(`python3 退出 ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('CS12-N2: DNS internal 命中词捕获(未定义名回归)', () => {
  const out = py(`sn.run_dns_matchers(
    [{'type': 'word', 'words': ['cloudflare'], 'internal': True, 'name': 'prov'}],
    ['cloudflare-dns-ns.example.com', '1.2.3.4'])`);
  assert.deepEqual(out, { __vars__: { prov: 'cloudflare' } });
});

test('CS13-1: HTTP 匹配器用 header/body, 不引未定义 answers', () => {
  const out = py(`sn.apply_matchers(
    [{'type': 'word', 'words': ['nginx'], 'name': 'srv', 'part': 'header'}],
    200, {'Server': 'nginx/1.2'}, b'hello')`);
  // 非 internal+name 不捕获(F29 原语义)——真命中返回 True
  assert.equal(out, true);
});

test('CS14-2: internal-only 过滤(非 internal 命中词不入 __vars__)', () => {
  const out = py(`sn.apply_matchers(
    [{'type': 'word', 'words': ['hello'], 'name': 'w', 'internal': False}],
    200, {}, b'hello world')`);
  assert.equal(out, true);
});

test('CS14-3: 双 internal 命中词累积(不早退)', () => {
  const out = py(`sn.apply_matchers([
      {'type': 'word', 'words': ['alpha'], 'internal': True, 'name': 'first', 'part': 'body'},
      {'type': 'word', 'words': ['beta'], 'internal': True, 'name': 'second', 'part': 'body'}],
    200, {}, b'alpha beta')`);
  assert.deepEqual(out, { __vars__: { first: 'alpha', second: 'beta' } });
});

test('CS15-5/F5: or 组合排除 internal 占位(占位不再恒真)', () => {
  // internal 占位命中 + 真实 matcher 未命中 → or 下不判中
  const out = py(`sn.apply_matchers([
      {'type': 'word', 'words': ['alpha'], 'internal': True, 'name': 'v'},
      {'type': 'word', 'words': ['never-there']}],
    200, {}, b'alpha', req_condition='or')`);
  assert.equal(out, false);
});

test('CS14-6: DNS 组合读自身参数, 不继承 HTTP 段条件', () => {
  const out = py(`sn.run_dns_matchers(
    [{'type': 'word', 'words': ['x']}, {'type': 'word', 'words': ['y']}],
    ['x.example.com'], req_condition=None)`);
  assert.equal(out, false);
});

test('CS14-7: DNS 混合型 matcher 索引对齐(非 word 记 None)', () => {
  const out = py(`sn.run_dns_matchers([
      {'type': 'status', 'status': [200]},
      {'type': 'word', 'words': ['cloudflare'], 'internal': True, 'name': 'prov'}],
    ['cloudflare-ns.example.com'])`);
  assert.deepEqual(out, { __vars__: { prov: 'cloudflare' } });
});

test('R32D42-P1/F6: 捕获跳继续走链, 末跳必败不产 finding', () => {
  const out = py(`sn.execute_template(
    {'id': 't', 'info': {'name': 't', 'severity': 'info'},
     'http': [
       {'path': '/hop1', 'matchers': [
          {'type': 'word', 'words': ['alpha'], 'internal': True, 'name': 'rel'}]},
       {'path': '/hop2?r={{rel}}', 'matchers': [
          {'type': 'word', 'words': ['MUST-NOT-EXIST']}]}]},
    base)`, { server: true });
  // 修复前: 首跳 dict 被当命中 → 误报 + 链断
  assert.deepEqual(out, []);
});

test('R32D42-P1/F6: 末跳真命中则报且归因末跳(matched-at)', () => {
  const out = py(`sn.execute_template(
    {'id': 't', 'info': {'name': 't', 'severity': 'info'},
     'http': [
       {'path': '/hop1', 'matchers': [
          {'type': 'word', 'words': ['alpha'], 'internal': True, 'name': 'rel'}]},
       {'path': '/hop2', 'matchers': [
          {'type': 'word', 'words': ['nothing-here']}]}]},
    base)`, { server: true });
  assert.equal(out.length, 1);
  assert.ok(out[0]['matched-at'].endsWith('/hop2'), `归因末跳: ${out[0]['matched-at']}`);
});

test('CS15-F6 修: 混合型(真命中+同请求捕获)必须报 finding', () => {
  const out = py(`sn.execute_template(
    {'id': 'mix', 'info': {'name': 'mix', 'severity': 'info'},
     'http': [{'path': '/hop1', 'matchers': [
        {'type': 'word', 'words': ['alpha'], 'internal': True, 'name': 'rel'},
        {'type': 'word', 'words': ['release']}]}]},
    base)`, { server: true });
  // 批次 X 回归形状: dict→continue 把该报的命中丢了
  assert.equal(out.length, 1);
  assert.ok(out[0]['matched-at'].endsWith('/hop1'));
});
