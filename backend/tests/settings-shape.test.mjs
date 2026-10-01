/**
 * settings-shape (CS37-F1): getSettings 形状回归锁——
 * BF 的 recon 读面整字典塌成掩码串穿过全部绿灯(38 测试+tsc+oxlint),
 * 本锁封堵: 每源必须是对象; 凭据叶=掩码形态; 非凭据叶原样。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('getSettings: recon 源叶级掩码, 非凭据叶原样(形状锁)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-shape-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  process.env.SPECTRE_DATA_DIR = dir;
  process.env.INTERNAL_TOKEN ||= 'shape-test';
  process.env.TEMPORAL_ADDRESS ||= '127.0.0.1:7233';
  const prevCwd = process.cwd();
  process.chdir(join(ROOT, 'backend'));
  try {
    const m = await import('../src/agent-settings.mjs');
    const { setPrefs } = await import('../src/projects.mjs');
    setPrefs({
      reconApiKeys: {
        fofa: { baseUrl: 'https://fofa.example', email: 'u@x.y', key: 'sk-1234567890' },
        censys: { id: 'census-id-1', secret: 'topsecret9' },
      },
    });
    const st = m.getSettings();
    const fofa = st.reconSources.fofa;
    assert.equal(typeof fofa, 'object', 'recon 源必须是对象(不得塌成字符串)');
    assert.equal(fofa.baseUrl, 'https://fofa.example', '非凭据叶 baseUrl 原样');
    assert.equal(fofa.email, 'u@x.y', '非凭据叶 email 原样');
    assert.equal(fofa.key, '••••7890', '凭据叶 key 掩码(••••+尾4)');
    const censys = st.reconSources.censys;
    assert.equal(typeof censys, 'object', 'censys 源必须是对象');
    assert.equal(censys.id, 'census-id-1', 'censys id 原样(非 SECRET_LEAF 集)');
    assert.equal(censys.secret, '••••ret9', '凭据叶 secret 掩码(••••+尾4)');
    // common.llm 掩码不回归
    setPrefs({ commonSettings: { llm: { format: 'openai', baseUrl: 'https://x', apiKey: 'sk-abcdef1234', model: 'm' } } });
    assert.equal(m.getSettings().common.llm.apiKey, '••••1234', 'common.llm.apiKey 掩码保持');
  } finally {
    process.chdir(prevCwd);
    delete process.env.SPECTRE_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
