import Fastify from 'fastify';
import { config } from './config.js';
import { ping, pool } from './db/pool.js';
import { mdoPool } from './db/mdo.js';
import * as qb from './services/qbittorrent.js';
import sitesRoutes from './routes/sites.js';
import rulesRoutes from './routes/rules.js';
import schedulerRoutes from './routes/scheduler.js';
import downloadsRoutes from './routes/downloads.js';
import seedRoutes from './routes/seed.js';
import discoverRoutes from './routes/discover.js';
import { startScheduler, stopScheduler } from './scheduler.js';

const app = Fastify({ logger: { level: config.server.logLevel } });

app.register(sitesRoutes);
app.register(rulesRoutes);
app.register(schedulerRoutes);
app.register(downloadsRoutes);
app.register(seedRoutes);
app.register(discoverRoutes);

app.get('/health', async () => {
  const out = { ok: true, db: 'unknown', qb: 'unknown' };

  try {
    out.db = (await ping()) ? 'ok' : 'error';
    if (out.db !== 'ok') out.ok = false;
  } catch (err) {
    out.db = `error: ${err.message}`;
    out.ok = false;
  }

  try {
    out.qb = await qb.getVersion();
  } catch (err) {
    out.qb = `error: ${err.message}`;
    out.ok = false;
  }

  return out;
});

app.post('/api/torrents', async (req, reply) => {
  const { urls, url, savePath, category, tags, paused } = req.body ?? {};
  const target = urls ?? url;
  if (!target) return reply.code(400).send({ ok: false, error: 'urls is required' });

  try {
    const result = await qb.addTorrent({ urls: target, savePath, category, tags, paused: !!paused });
    return { ok: true, result };
  } catch (err) {
    return reply.code(502).send({ ok: false, error: err.message });
  }
});

app.get('/api/torrents', async (req, reply) => {
  const { filter = 'all', category = '' } = req.query ?? {};
  try {
    return await qb.listTorrents({ filter, category });
  } catch (err) {
    return reply.code(502).send({ ok: false, error: err.message });
  }
});

app
  .listen({ port: config.server.port, host: '127.0.0.1' })
  .then((addr) => {
    app.log.info(`pt-download listening on ${addr}`);
    startScheduler();
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    stopScheduler();
    await app.close().catch(() => {});
    await pool.end().catch(() => {});
    await mdoPool.end().catch(() => {});
    process.exit(0);
  });
}
