#!/usr/bin/env node
/**
 * SPECTRE Temporal worker entrypoint.
 *
 * Polls the 'spectre' task queue, executing AutoPwn orchestration
 * workflows whose activities drive the pi agent runtime over HTTP.
 */

import { Worker } from '@temporalio/worker';

import * as activities from './activities.mjs';
import { CONFIG } from './src/config.mjs';

const worker = await Worker.create({
  workflowsPath: new URL('./workflows.mjs', import.meta.url).pathname,
  activities,
  taskQueue: CONFIG.temporalTaskQueue,
});

console.log(
  `[worker] polling task queue "${CONFIG.temporalTaskQueue}" @ ${CONFIG.temporalAddress}`,
  `activities: ${Object.keys(activities).join(', ')}`,
);
await worker.run();
