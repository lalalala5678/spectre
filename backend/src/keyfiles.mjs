/**
 * 凭据→注入文件同步(CS3-#10 从 routes.mjs 抽离的 ~77 行业务块)。
 *
 * 保存 recon-source 凭据后: 按消费组(c2/nday/phish/recon)最小权限落盘
 * 各 key 文件, 并按"已验证才挂载"闸门重建 recon-datasources / nday-intel
 * MCP 注册。零污染原则: 无凭据的源不进任何注入文件(F14)。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { CONFIG } from './config.mjs';
import { getPrefs } from './projects.mjs';
import { RECON_SOURCES_INTERNAL, enabledReconSources, hasSourceCredential } from './agent-settings.mjs';
import { loadMcpConfig, saveMcpConfig } from './sandbox/mcp.mjs';
import { applyMcpAndMounts } from './sandbox/apply-config.mjs';
import path_mod from 'node:path';

/** F14: 数据源文件只含有凭据的源(零污染)——无凭据残留不进任何注入文件。
 * CS17-4: 谓词收敛到 agent-settings.hasSourceCredential 单源(此前本处
 * 多认 id/user——censys id-only 也会进注入文件)。 */
const hasCred = hasSourceCredential;  // CS18-F5: 消透传包装

/** 按消费组过滤(keys → {sid: cfg}), skip 为排除的伪源。 */
function byGroup(keys, agents, skip) {
  const out = {};
  for (const [sid, cfg] of Object.entries(keys)) {
    if (skip.includes(sid) || !hasCred(cfg, sid)) continue;
    const def = RECON_SOURCES_INTERNAL[sid];
    if (def && (def.agents ?? ['recon']).includes(agents)) out[sid] = cfg;
  }
  return out;
}

/** 全量凭据→四组文件+MCP 闸门重建。 */
export async function syncSourceKeyFiles() {
  const root = CONFIG.dataDir;
  const keys = getPrefs().reconApiKeys ?? {};
  const skip = ['brute', 'smtp'];

  // c2 免杀云查 keys(只写已通过 validate 的源;失败即不落盘)
  const c2Out = byGroup(keys, 'c2', skip);
  await mkdir(path_mod.join(root, 'tools/c2'), { recursive: true });
  await writeFile(path_mod.join(root, 'tools/c2/api-keys.json'),
    JSON.stringify(c2Out, null, 1), 'utf8');

  // nday 情报源 keys(已验证才落盘)
  const ndayOut = byGroup(keys, 'nday', skip);
  await mkdir(path_mod.join(root, 'tools/nday'), { recursive: true });
  await writeFile(path_mod.join(root, 'tools/nday/api-keys.json'),
    JSON.stringify(ndayOut, null, 1), 'utf8');

  // phish SMTP(仅 smtp 源且已验证)
  const smtpCfg = keys.smtp ?? {};
  const smtpHasSecret = smtpCfg.user || smtpCfg.password;
  await mkdir(path_mod.join(root, 'tools/phish'), { recursive: true });
  await writeFile(path_mod.join(root, 'tools/phish/smtp.json'),
    JSON.stringify(smtpHasSecret ? { host: smtpCfg.host,
      port: Number(smtpCfg.port) || 587, user: smtpCfg.user,
      pass: smtpCfg.password } : {}, null, 1), 'utf8');

  // 最小权限: recon server 的配置文件只收 recon 组源——此前全量落盘
  // 使 c2 组 key(virustotal/hybridanalysis)混入(server 虽按注册表忽略,
  // 但 key 材料不应越组落盘)。
  const withCreds = {};
  for (const [sid, cfg] of Object.entries(keys)) {
    if (sid === 'brute' || !hasCred(cfg, sid)) continue;
    const def = RECON_SOURCES_INTERNAL[sid];
    if (def && !(def.agents ?? ['recon']).includes('recon')) continue;
    withCreds[sid] = cfg;
  }
  await writeFile(path_mod.join(root, 'recon-datasources.json'),
    JSON.stringify(withCreds), 'utf8');

  const list = await loadMcpConfig();
  const rest = list.filter(s => s.name !== 'recon-datasources'
    && s.name !== 'nday-intel');
  if (enabledReconSources().length) {
    rest.push({
      name: 'recon-datasources', transport: 'stdio', agents: ['recon'],
      enabled: true,
      command: ['node', path_mod.join(root, 'mcp-recon-datasources.mjs')],
      env: {}, where: 'host',
    });
  }
  // nday 情报 MCP:NVD key 验证落盘⇄挂载(镜像 recon-datasources 闸门;
  // 裸 API 不给智能体——key 读取/限流/格式化都在工具内)。
  if (ndayOut.nvd?.key) {
    rest.push({
      name: 'nday-intel', transport: 'stdio', agents: ['nday'],
      enabled: true,
      command: ['node', path_mod.join(root, 'mcp-nday-intel.mjs')],
      env: {}, where: 'host',
    });
  }
  await saveMcpConfig(rest);
  await applyMcpAndMounts();
}
