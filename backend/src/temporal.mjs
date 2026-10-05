/**
 * Temporal client access for the runtime process.
 *
 * The runtime only *starts* AutoPwn workflows and describes them; all
 * orchestration logic lives in the worker (workflows.mjs).
 */

import { Client, Connection } from '@temporalio/client';

import { CONFIG } from './config.mjs';

let clientPromise = null;

// CS74-N5: Connection 失败在源点包一层指路(三调用方
// tools.dispatch/routes×2 共享; @temporalio/client 原文裸串对
// 单机部署用户不可读——Temporal 为可选编排链, deploy/README 有载)。
async function temporalClient() {
  clientPromise ??= (async () => {
    let connection;
    try {
      connection = await Connection.connect({
        address: CONFIG.temporalAddress,
      });
    } catch (e) {
      throw Object.assign(
        new Error(`Temporal 不可达(${e?.message ?? e})——并行编排经 Temporal(可选依赖); 单机可由编排会话逐个 spawn_agent 替代, 启用见 deploy/README`),
        { temporalUnreachable: true });
    }
    return new Client({ connection });
  })();
  return clientPromise;
}

export async function startAutopwn({ engagementId, instruction, agents,
                                     orchestratorSessionId, workSessionId }) {
  const id = engagementId || `eng-${Date.now().toString(36)}`;
  // The orchestrator never schedules itself.
  const targets = [...new Set(agents)].filter((key) => key !== 'autopwn');  // R7-F5: 去重
  if (targets.length === 0) {
    throw Object.assign(new Error('未选择任何 stage agent'), { statusCode: 400 });
  }
  const client = await temporalClient();
  const handle = await client.workflow.start('autoPwnWorkflow', {
    args: [{ engagementId: id, instruction, agents: targets,
             orchestratorSessionId: orchestratorSessionId ?? null,
             workSessionId: workSessionId ?? null }],
    taskQueue: CONFIG.temporalTaskQueue,
    workflowId: `autopwn-${id}`,
  });
  return { engagementId: id, workflowId: handle.workflowId, agents: targets };
}

/** Fire a signal at a running engagement (used by orchestrator tools). */
export async function signalEngagement(workflowId, signalName, args) {
  const client = await temporalClient();
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(signalName, args);
}
/** r46-D2: 取消原语——编排者对冗余/失控战役的显式终止(三轮点名)。
 * cancel 触发 Temporal 优雅取消(child activity 收 CANCELLED); 已完成
 * 战役 cancel 为 no-op(幂等)。 */
export async function cancelEngagement(workflowId) {
  const client = await temporalClient();
  const handle = client.workflow.getHandle(workflowId);
  const desc = await handle.describe();
  const status = desc.status?.name ?? 'RUNNING';
  if (status !== 'RUNNING') return { workflowId, status, cancelled: false };
  await handle.cancel();
  return { workflowId, status, cancelled: true };
}
export async function describeWorkflow(workflowId) {
  const client = await temporalClient();
  const handle = client.workflow.getHandle(workflowId);
  const desc = await handle.describe();
  return {
    workflowId,
    status: desc.status?.name ?? 'RUNNING',
    startTime: desc.startTime?.toISOString?.() ?? null,
  };
}
