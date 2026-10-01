/**
 * llm-routing (R32D44-P0-1): 单 agent 覆盖的鉴权路由机锁。
 *
 * 背景: modelCatalog 曾对所有 scope 硬编码 provider=默认 PROVIDER_ID,
 * pi-ai requireProvider(model) 按 model.provider 找 auth resolver——
 * 每 agent 覆盖的 key 在流式路径永远不可达(聊天出站全用默认 key,
 * 而保存探测用覆盖 key; R32D44 mock 审计实锤)。本测试锁死:
 *  1. 每 scope 的 live model.provider 指向自己的 provider id;
 *  2. modelForAgent 对已注册 scope 返回该 scope 的对象(非默认对象);
 *  3. 覆盖 prefs 写入后, agent scope 的 auth resolve 返回覆盖 key。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKEND = join(ROOT, 'backend');

/** 隔离数据根下跑 backend 侧脚本; prefs 用进程内 setPrefs 预置
 * (不落盘——buildPi/effective* 读的就是这份内存态, 且避开
 * 'unconfigured' id 碰撞所需的真实模型名)。 */
function runBackend(script, prefsSeed = null) {
  const dir = mkdtempSync(join(tmpdir(), 'llmroute-'));
  try {
    mkdirSync(join(dir, 'state'), { recursive: true });
    const seed = prefsSeed
      ? `const { setPrefs } = await import('./src/projects.mjs');
`
        + `setPrefs(${JSON.stringify(prefsSeed)});`
      : '';
    const full = [
      `process.env.SPECTRE_DATA_DIR = ${JSON.stringify(dir)};`,
      `process.chdir(${JSON.stringify(BACKEND)});`,
      seed,
      script,
    ].join('\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-'], {
      input: full, encoding: 'utf8', timeout: 30000, cwd: BACKEND,
    });
    if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('P0-1: 每 scope model.provider 指向自己的 provider(鉴权路由)', async () => {
  const out = runBackend(`
    const { buildPi } = await import('./src/pi.mjs');
    const { modelForAgent } = await buildPi();
    const picks = {};
    for (const k of ['recon', 'report', 'c2', 'autopwn']) {
      picks[k] = { provider: modelForAgent(k).provider, id: modelForAgent(k).id };
    }
    picks.__default = { provider: modelForAgent('__none__').provider };
    console.log(JSON.stringify(picks));
  `, {
    commonSettings: { llm: {
      format: 'openai', baseUrl: 'https://default.example/v4',
      apiKey: 'default-key', model: 'default-model',
    } },
    agentLlm: { report: { apiKey: 'report-override-key', model: 'report-model' } },
  });
  // 覆盖 scope: 自己的 provider + 自己的 model
  assert.equal(out.report.provider, 'spectre-report', `report provider: ${out.report.provider}`);
  assert.equal(out.report.id, 'report-model');
  // 未覆盖 scope: 自己的 provider(默认配置的身份)
  assert.equal(out.recon.provider, 'spectre-recon');
  assert.equal(out.c2.provider, 'spectre-c2');
  assert.equal(out.autopwn.provider, 'spectre-autopwn');
  // 防御分支: 未知 scope 落默认 provider
  assert.equal(out.__default.provider, 'spectre-llm');
});

test('P0-1: 覆盖 key 在 auth resolve 路径可达(resolver 返回覆盖 key)', async () => {
  const out = runBackend(`
    const { effectiveLlmFor } = await import('./src/agent-settings.mjs');
    console.log(JSON.stringify({
      report: { apiKey: effectiveLlmFor('report').apiKey, model: effectiveLlmFor('report').model },
      recon: { apiKey: effectiveLlmFor('recon').apiKey },
    }));
  `, {
    commonSettings: { llm: {
      format: 'openai', baseUrl: 'https://default.example/v4',
      apiKey: 'default-key', model: 'default-model',
    } },
    agentLlm: { report: { apiKey: 'report-override-key', model: 'report-model' } },
  });
  assert.equal(out.report.apiKey, 'report-override-key');
  assert.equal(out.report.model, 'report-model');
  assert.equal(out.recon.apiKey, 'default-key');
});
