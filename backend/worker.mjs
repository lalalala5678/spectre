import { Worker } from '@temporalio/worker';
import { Connection } from '@temporalio/client';  // R32D105-F1
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

// R32D105-F2(P3): 文档/横幅均称"静默重试"——此前 Worker.create 的
// TransportError 未捕获, 实际立即 rc=1 崩溃(systemd 下 2s 循环)。包
// 退避重试兑现承诺(5s→60s 封顶, 每次打一行不刷屏)。
const bootWorker = async () => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const conn = await Connection.connect({ address: CONFIG.temporalAddress });  // R32D105-F1
      const w = await Worker.create({
        workflowsPath: new URL('./workflows.mjs', import.meta.url).pathname,
        activities,
        taskQueue: CONFIG.temporalTaskQueue,
        connection: conn,
      });
      console.log(
        `[worker] polling task queue "${CONFIG.temporalTaskQueue}" @ ${CONFIG.temporalAddress}`,
        `activities: ${Object.keys(activities).join(', ')}`,
      );
      await w.run();
      return;
    } catch (err) {
      const delay = Math.min(5000 * attempt, 60_000);
      console.warn(`[worker] Temporal ${CONFIG.temporalAddress} 连接失败(第 ${attempt} 次, ${delay / 1000}s 后重试): ${err?.message ?? err}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
};
await bootWorker();
