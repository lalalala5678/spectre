/**
 * Central configuration for the SPECTRE backend.
 *
 * Reads `backend/.env` once at import time and exports frozen constants.
 * Every module derives its settings from here — no scattered literals.
 */

import { existsSync, readFileSync } from 'node:fs';

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    // R32D47-P3: 判据用 !== undefined——空串 env 此前被 !truthy 判为
    // 未设, .env 值照样灌入(想用空串屏蔽 .env 行必须物理删行)。
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
}

loadEnvFile(new URL('../.env', import.meta.url).pathname);

// F10(部署审计四轮): 运行时版本横幅——依赖声明 node>=22.19, 低版本
// 装机(npm 警告被略过)在此给出明确提示而非运行中诡异失败。
const _nv = process.versions.node.split('.').map(Number);
if (_nv[0] < 22) {
  // N8(部署审计五轮): 与 console prebuild 同门槛硬拒——非对称策略
  //(一硬一软)此前被列为反直觉点。
  throw new Error(
    `[config] Node ${process.versions.node} 低于受支持版本 22 — 升级 Node 后重试(console 构建同为硬门)`);
}

// G3(部署审计六轮): .env.example 的占位值(change-me*)静默过闸——公开
// 仓库的已知值等于无令牌, 直接拒启。
function rejectPlaceholder(name, value) {
  if (/^change-me/i.test(String(value))) {
    throw new Error(
      `[config] ${name} 仍是 .env.example 占位值 —— 填入真实随机值后重启(INTERNAL_TOKEN 用 openssl rand -hex 32 生成)`);
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var: ${name} — 复制 backend/.env.example 为 .env 并填值后重启`);
  }
  rejectPlaceholder(name, value);
  return value;
}

/** 自测-9: 端口图单源——提示词 OOB 收集器/测试避让段/文档此前三处
 * 硬编码互不引用, 服务端口一变即漂移。所有派生方从此处取。 */
export const PORT_MAP = Object.freeze({
  runtime: Number(process.env.PORT || 8090),
  gateway: Number(process.env.GATEWAY_PORT || 8081),
  caddy: 443,
  temporal: Number(process.env.TEMPORAL_ADDRESS_PORT || 7233),
  oobCollector: 19999,
  /** 测试专用动态端口段(避让全部服务端口, 段宽 400)。 */
  testPortBase: 19500,
  testPortSpan: 400,
});

export const CONFIG = Object.freeze({
  port: PORT_MAP.runtime,
  host: '127.0.0.1',

  // R32D44-llm: LLM 直连 env(LLM_BASE_URL/KEY/MODEL)已删——统一平台
  // 设置页配置(默认供应商+单 agent 覆盖), 见 agent-settings.mjs。

  internalToken: required('INTERNAL_TOKEN'),
  temporalAddress: process.env.TEMPORAL_ADDRESS || '127.0.0.1:7233',
  temporalTaskQueue: 'spectre',

  /** Hard caps guarding the runtime against oversized payloads. */
  maxPromptChars: 32_000,
  maxBodyBytes: 1 << 20,
  maxIdleWaitMs: 600_000,
  busJournalLimit: 5_000,

  // CS23-N13: dmReportMaxChars 已删(全仓零引用; 实际生效的 DM 裁剪
  // 是 dmDigestChars=400, sessions.mjs 消费)。
  /** Bus vulnerability detail cap (漏洞 panel expand view), marker-clipped. */
  busDetailMaxChars: 4_000,
  /** Completion-DM digest cap (full text lives in the task report). */
  dmDigestChars: 400,

  /**
   * LLM transport resilience (pi-ai retryProviderRequest): retries only
   * retryable errors (429/5xx/network) before the stream starts, honors
   * Retry-After. Default in pi is 0 — B-2 died on the first hiccup.
   */
  llmMaxRetries: 3,
  /** HTTP timeout per LLM request. */
  llmTimeoutMs: 300_000,
  /** L2c: 429 backpressure cooldown (exponential from base, capped). */
  llmCooldownBaseMs: 5_000,
  llmCooldownMaxMs: 60_000,
  /** Max report-nudge loops before the system synthesizes the report. */
  reportNudgeMax: 2,
  /** query_intel formatted output cap. */
  intelDigestChars: 6_000,

  /** Durable state directory (WAL): survives restarts, updates, power loss. */
  dataDir: process.env.SPECTRE_DATA_DIR || '/var/lib/spectre',

  /** Session summary policy (same model as chats; cost bounded by policy). */
  summaryMinDelta: Number(process.env.SUMMARY_MIN_DELTA || 4),
  summaryEagerDelta: Number(process.env.SUMMARY_EAGER_DELTA || 8),
  summaryIdleMs: Number(process.env.SUMMARY_IDLE_MS || 600_000),
});
