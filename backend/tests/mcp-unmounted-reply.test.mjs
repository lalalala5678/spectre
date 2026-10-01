/**
 * mcp-unmounted-reply (CS44-F1 机锁): MCP 桥「未挂载工具必须得到
 * isError 回执」——此前 mcp-recon-datasources 的 reply 引用 TDZ 中的
 * a, 未挂载路径抛 ReferenceError, 诊断永不可达(AGENTS 原则4 击穿)。
 * 防线: 真起桥进程(stdio, 无端口), 发未挂载工具调用 → 断言 isError
 * 回执+进程存活。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function mcpCall(procPath, name) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [procPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('MCP 桥 8s 无回执')); }, 8000);
    child.stdout.on('data', () => {
      if (out.includes('\n')) {
        clearTimeout(timer);
        child.kill('SIGKILL');
        resolve({ out, err });
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: { query: 'x' } },
    }) + '\n');
  });
}

test('mcp-recon-datasources: 未挂载工具 → isError 回执且不崩(CS44-F1 锁)', async () => {
  const proc = join(ROOT, 'docs', 'recon-skills', 'mcp-recon-datasources.mjs');
  const { out, err } = await mcpCall(proc, 'ipinfo');   // 未配置凭据=未挂载
  const line = out.split('\n').find(l => l.startsWith('{'));
  assert.ok(line, `应有 JSON-RPC 回执, 实得: ${out.slice(0, 200)}`);
  const r = JSON.parse(line);
  assert.equal(r.id, 1);
  assert.equal(r.result?.isError, true, '未挂载必须 isError:true');
  assert.match(r.result?.content?.[0]?.text ?? '', /未挂载/, '回执须含未挂载诊断');
  assert.ok(!err.includes('ReferenceError'), `不得 TDZ 崩溃: ${err.slice(0, 200)}`);
});
