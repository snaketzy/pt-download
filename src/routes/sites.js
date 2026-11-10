import { pool } from '../db/pool.js';
import { pollAndDispatch } from '../services/poller.js';

export default async function sitesRoutes(app) {
  app.get('/api/sites', async () => {
    const [rows] = await pool.query(
      'SELECT id, name, base_url, rss_url, poll_interval_sec, enabled FROM sites ORDER BY id',
    );
    return rows;
  });

  app.post('/api/sites', async (req, reply) => {
    const { name, baseUrl, rssUrl, pollIntervalSec } = req.body ?? {};
    if (!name) return reply.code(400).send({ ok: false, error: 'name is required' });

    const [res] = await pool.query(
      `INSERT INTO sites (name, base_url, rss_url, poll_interval_sec)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         base_url = VALUES(base_url),
         rss_url = VALUES(rss_url),
         poll_interval_sec = VALUES(poll_interval_sec)`,
      [name, baseUrl ?? null, rssUrl ?? null, pollIntervalSec ?? 600],
    );
    return { ok: true, id: res.insertId || null, affected: res.affectedRows };
  });

  app.post('/api/sites/:id/poll', async (req, reply) => {
    const [rows] = await pool.query('SELECT id, name, rss_url FROM sites WHERE id = ?', [req.params.id]);
    const site = rows[0];
    if (!site) return reply.code(404).send({ ok: false, error: 'site not found' });

    try {
      // 抓取 → 入库 → 立即评估规则并下发；?dryRun=1 只预览不下发。
      const result = await pollAndDispatch(
        { id: site.id, name: site.name, rssUrl: site.rss_url },
        { dryRun: req.query?.dryRun === '1' },
      );
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(502).send({ ok: false, error: err.message });
    }
  });
}
