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

test('syncSourceKeyFiles: smtp allow_plaintext 透传+schema 下发(CS59-F1 锁)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-smtp-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  process.env.SPECTRE_DATA_DIR = dir;
  process.env.INTERNAL_TOKEN ||= 'shape-test';
  process.env.TEMPORAL_ADDRESS ||= '127.0.0.1:7233';
  const prevCwd = process.cwd();
  process.chdir(join(ROOT, 'backend'));
  try {
    const { setPrefs } = await import('../src/projects.mjs');
    const { settingsSchema } = await import('../src/agent-settings.mjs');
    const { syncSourceKeyFiles } = await import('../src/keyfiles.mjs');
    const { readFileSync } = await import('node:fs');
    // schema 面: allow_plaintext 下发 select(设置页可持久化通道)
    const phish = settingsSchema().agents.find(a => a.agentKey === 'phish');
    const smtpSrc = phish.sources.find(sv => sv.id === 'smtp');
    const ap = smtpSrc.fields.find(f => f.id === 'smtp.allow_plaintext');
    assert.ok(ap, 'smtp 源须下发 allow_plaintext 字段');
    assert.equal(ap.type, 'select', 'allow_plaintext 须为 select');
    // 落盘面: 'true' 字符串→布尔透传; 'false'/缺省→不落键
    setPrefs({ reconApiKeys: { smtp: { host: 'h', port: 25, user: 'u', password: 'p', allow_plaintext: 'true' } } });
    await syncSourceKeyFiles();
    const on = JSON.parse(readFileSync(join(dir, 'tools/phish/smtp.json'), 'utf8'));
    assert.equal(on.allow_plaintext, true, "allow_plaintext='true' 须透传布尔 true");
    setPrefs({ reconApiKeys: { smtp: { host: 'h', port: 25, user: 'u', password: 'p' } } });
    await syncSourceKeyFiles();
    const off = JSON.parse(readFileSync(join(dir, 'tools/phish/smtp.json'), 'utf8'));
    assert.equal(off.allow_plaintext, undefined, '未开启时不得落 allow_plaintext 键');
  } finally {
    process.chdir(prevCwd);
    delete process.env.SPECTRE_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recon-source select 叶子 options 校验(R32D78-N1 锁)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-sel-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  process.env.SPECTRE_DATA_DIR = dir;
  process.env.INTERNAL_TOKEN ||= 'shape-test';
  process.env.TEMPORAL_ADDRESS ||= '127.0.0.1:7233';
  const prevCwd = process.cwd();
  process.chdir(join(ROOT, 'backend'));
  try {
    const m = await import('../src/agent-settings.mjs');
    const bad = await m.saveSetting({ group: 'recon-source', field: 'smtp.allow_plaintext', value: 'maybe' });
    assert.equal(bad.ok, false, "allow_plaintext='maybe' 须拒");
    assert.match(bad.error ?? '', /true\/false/, '错误信息须列合法选项');
    // 非法值不得落 prefs
    const { getPrefs } = await import('../src/projects.mjs');
    assert.equal(getPrefs().reconApiKeys?.smtp?.allow_plaintext, undefined, '非法值不得落盘');
  } finally {
    process.chdir(prevCwd);
    delete process.env.SPECTRE_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
