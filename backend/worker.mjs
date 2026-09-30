import { Worker } from '@temporalio/worker';
import net from 'node:net';

import * as activities from './activities.mjs';
import { CONFIG } from './src/config.mjs';

// R17-2(十七轮): Temporal 不可达时 Worker.create 静默挂起轮询重试, 用户
// 直到发起战役才失败——启动前 TCP 探测给显式警告(不阻断启动)。
await new Promise(resolve => {
  const [h, p] = String(CONFIG.temporalAddress).split(':');
  const s = net.createConnection({ host: h || '127.0.0.1', port: Number(p) || 7233, timeout: 3000 });
  s.on('connect', () => { s.destroy(); resolve(); });
  s.on('error', () => {
    console.warn(`[worker] 警告: Temporal ${CONFIG.temporalAddress} 不可达——worker 将静默重试, 战役调度(AutoPwn)在 server 就绪前不可用; 见 deploy/README「Temporal(可选编排链)」`);
    resolve();
  });
  s.on('timeout', () => {
    s.destroy();
    console.warn(`[worker] 警告: Temporal ${CONFIG.temporalAddress} 连接超时(继续启动, 轮询重试中)`);
    resolve();
  });
});

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
