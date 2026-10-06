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
