/**
 * Bridge official pi harness tools (bash/read/write/edit) onto the bare
 * Agent's AgentTool signature. The official factories expect a harness
 * execution context ({ env }) plus an invocation stub — we supply both,
 * keeping the official schema, description, truncation and spill
 * semantics byte-for-byte. Zero pi modifications.
 */
import { looksLikeInstall, appendInstallLog } from './container.mjs';
import {
  createBashTool, createReadTool, createWriteTool, createEditTool,
} from '@earendil-works/pi-agent-core';

import { PI_CONTEXT } from './exec-env.mjs';

/** In-memory memo stub for the official invocation contract. */
function stubInvocation(toolCallId) {
  const memos = new Map();
  return {
    invocationId: toolCallId,
    operationId: `op-${toolCallId}`,
    turnId: `turn-${toolCallId}`,
    getMemo: async name => memos.get(name),
    setMemo: async (name, value) => {
      if (value === undefined) memos.delete(name);
      else memos.set(name, value);
    },
  };
}

/**
 * Adapt one harness tool to the bare-Agent AgentTool shape.
 * Official execute: (toolCallId, params, onUpdate, toolContext,
 * invocation, context) — bare Agent calls (toolCallId, params, signal?,
 * onUpdate?). Updates are streamed through when the agent supports them.
 */

/** loop-auth: 内网/localhost 目标提取+scope 校验(与 shell 门同源
 * scope.json, 逐次读)。命中未授权目标返回该目标串, 否则 null。 */
function scopeTargetsOf() {
  try {
    return JSON.parse(readFileSync(join(CONFIG.dataDir, 'tools/c2/scope.json'), 'utf8'))?.targets ?? [];
  } catch { return []; }
}
function bashScopeGate(command) {
  const targets = scopeTargetsOf();
  const ipRe = /\b(127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g;
  const cands = new Set([...String(command).matchAll(ipRe)].map(m => m[1]));
  if (/\blocalhost\b/i.test(command)) cands.add('localhost');
  for (const c of cands) {
    if (c === '127.0.0.53') continue;  // 系统解析器
    if (!targets.includes(c) && !(c === 'localhost' && targets.includes('127.0.0.1'))) return c;
  }
  return null;
}

export function adaptHarnessTool(tool, env, extraContext = {}) {
  return {
    name: tool.name,
    label: tool.label ?? tool.name,
    description: tool.description,
    parameters: tool.parameters,
    executionMode: tool.executionMode,
    execute: async (toolCallId, params, _signal, onUpdate) => {
      const toolContext = { env, ...extraContext };
      const update = typeof onUpdate === 'function' ? onUpdate : () => {};
      // Official bash has NO default timeout by contract; an unset
      // timeout here has hung whole agent turns (review round 1). The
      // adapter fills a 300s default WITHOUT touching the official
      // schema — agents can still pass a larger explicit value.
      const finalParams = tool.name === 'bash' && params.timeout === undefined
        ? { ...params, timeout: 300 } : params;
      // loop-auth-场景1: bash 主动出连授权门——授权此前只覆盖 shell
      // 通道, bash 里 curl/nmap 直连目标全放行(实测 crAPI 30080 裸跑)。
      // 内网段+localhost 目标不在 scope → 拦+申请指引(公网域名/CDN
      // 不拦——pip/npm 装包不受影响)。
      // 用户令(授权自治): 不做硬件拦截——命中未授权目标时照常执行,
      // 结果头部注入警告, 大模型自主判断(申请/停止/继续)。
      const authWarnHit = (tool.name === 'bash' && typeof params.command === 'string')
        ? bashScopeGate(params.command) : null;
      // Shared-layer install bookkeeping: bash-side installs bypass the
      // install REST, so record them into the install-log ledger here
      // (idempotent dedupe via last-line check).
      let out;
      try {
        out = await tool.execute(toolCallId, finalParams, update,
          toolContext, stubInvocation(toolCallId), PI_CONTEXT);
      } catch (err) {
        // loop22-#1: 官方 read 对 ENOENT reject undefined(pi 内部吞错,
        // 零 pi 修改约束)——裸串化成 "[object Object]" 无路径无原因
        // (缺陷 5136)。adapter 兜底: 人话+路径+码表措辞(FileError
        // 对齐 not_found/permission_denied), bash/write/edit 同防。
        const msg = (err && (err.message ?? err.text)) || String(err ?? '');
        // loop37-D3: 官方 bash 对非零退出码 throw(stderr=unknown 样本),
        // 整条标失败吞掉完整 stdout。有输出/退出码证据时降级为正常
        // 回执(标 rc, 保留输出)——exit 3; echo done 应标 rc=3 而非失败。
        if (tool.name === 'bash') {
          // loop37-D3 实证: 官方 bash 对 exitCode!==0 直接 throw Error(
          // message=输出+尾行 'Command exited with code N'——err.exitCode
          // 不存在), 此前判据拿不到结构化字段从未触发。
          const m = /\nCommand exited with code (\d+)$/.exec(String(err?.message ?? ''));
          if (m) {
            const outText = String(err.message).slice(0, m.index);
            return {
              content: [{
                type: 'text',
                text: (outText || '(无输出)')
                  + `\n[rc=${m[1]} 非零退出码——命令已执行, 以上为完整输出; 非 harness 故障]`,
              }],
            };
          }
        }
        const code = err?.code ?? (msg.includes('ENOENT') ? 'not_found'
          : msg.includes('EACCES') || msg.includes('permission') ? 'permission_denied'
          : err == null ? 'not_found(官方通道吞错, 无详情——多为文件不存在/无权限)'
          : 'unknown');
        const target = typeof finalParams?.path === 'string' ? finalParams.path
          : typeof finalParams?.file === 'string' ? finalParams.file : '';
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `${tool.name} 失败:${code}${target ? ` ${target}` : ''}` +
              `${msg && msg !== 'undefined' ? `: ${msg}` : '——官方通道未附错误详情'}` +
              (String(code).startsWith('not_found') ? '。检查路径是否正确; 需要时先用 bash ls 确认文件在。' : ''),
          }],
        };
      }
      if (tool.name === 'bash' && typeof params.command === 'string'
        && looksLikeInstall(params.command)) {
        appendInstallLog(params.command).catch(() => {});
      }
      // 授权自治: 未授权目标的警告注入输出头(命令已执行——回执如实,
      // 决策交给模型)。
      if (authWarnHit && out && Array.isArray(out.content)) {
        const first = out.content.find(c => c.type === 'text');
        if (first) first.text = `[授权提示] 本命令含未授权目标 ${authWarnHit}(不在渗透授权清单)——请自行判断: request_authorization 申请 / 停止 / 或确认为授权资产后继续。\n---\n${first.text ?? ''}`;
      }
      return out;
    },
  };
}

/** Official execution toolkit (bash/read/write/edit) bound to one env. */
export function buildOfficialTools(env) {
  return [
    adaptHarnessTool(createBashTool(), env),
    adaptHarnessTool(createReadTool(), env),
    adaptHarnessTool(createWriteTool(), env),
    adaptHarnessTool(createEditTool(), env),
  ];
}
