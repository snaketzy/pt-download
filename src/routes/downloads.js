import * as downloads from '../repositories/downloads.js';
import { syncFromQb } from '../services/seed.js';

export default async function downloadsRoutes(app) {
  // 本地 downloads 表（由下发落库 + qB 状态同步维护）。
  app.get('/api/downloads', async (req) => {
    const { siteId, state, limit } = req.query ?? {};
    return downloads.listDownloads({
      siteId: siteId ? Number(siteId) : null,
      state: state || null,
      limit: limit ? Number(limit) : 500,
    });
  });

  // 主动从 qB 拉一次状态（调度器每轮也会调用）。
  app.post('/api/downloads/sync', async (req, reply) => {
    try {
      return await syncFromQb();
    } catch (err) {
      return reply.code(502).send({ ok: false, error: err.message });
    }
  });
}
