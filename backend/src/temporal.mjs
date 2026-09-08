/**
 * Temporal client access for the runtime process.
 *
 * The runtime only *starts* AutoPwn workflows and describes them; all
 * orchestration logic lives in the worker (workflows.mjs).
 */

import { Client, Connection } from '@temporalio/client';

import { CONFIG } from './config.mjs';

let clientPromise = null;

async function temporalClient() {
  clientPromise ??= (async () => {
    const connection = await Connection.connect({
      address: CONFIG.temporalAddress,
    });
    return new Client({ connection });
  })();
  return clientPromise;
}

export async function startAutopwn({ engagementId, instruction, agents,
                                     orchestratorSessionId, workSessionId }) {
  const id = engagementId || `eng-${Date.now().toString(36)}`;
  // The orchestrator never schedules itself.
  const targets = agents.filter((key) => key !== 'autopwn');
  if (targets.length === 0) {
    throw Object.assign(new Error('no stage agents selected'), { statusCode: 400 });
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
