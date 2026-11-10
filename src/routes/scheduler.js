import { getSchedulerStatus, runTick } from '../scheduler.js';

export default async function schedulerRoutes(app) {
  app.get('/api/scheduler', async () => getSchedulerStatus());

  // 手动触发一轮；默认强制跑（忽略 poll_interval_sec），?force=0 则按到期判断。
  app.post('/api/scheduler/tick', async (req) => runTick({ force: req.query?.force !== '0' }));
}
