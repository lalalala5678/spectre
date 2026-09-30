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
      const out = await tool.execute(toolCallId, finalParams, update,
        toolContext, stubInvocation(toolCallId), PI_CONTEXT);
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
