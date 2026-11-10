import { getSeedStatus, computeCandidates, applyCleanup } from '../services/seed.js';
import { listPolicies, getEffectivePolicy, upsertPolicy, deletePolicy } from '../repositories/policies.js';

export default async function seedRoutes(app) {
  // 站点维度做种状态 + 分享率告警（仅告警，不做任何改动）。
  app.get('/api/seed/status', async (req, reply) => {
    try {
      return await getSeedStatus();
    } catch (err) {
      return reply.code(502).send({ ok: false, error: err.message });
    }
  });

  // 清理候选列表（人工确认用，不产生副作用）。
  app.get('/api/seed/candidates', async (req) => {
    const { siteId } = req.query ?? {};
    return computeCandidates({ siteId: siteId ? Number(siteId) : null });
  });

  // 人工确认后执行清理。
  app.post('/api/seed/apply', async (req, reply) => {
    const { hashes, deleteFiles = false, force = false } = req.body ?? {};
    try {
      return await applyCleanup({ hashes, deleteFiles: !!deleteFiles, force: !!force });
    } catch (err) {
      return reply.code(400).send({ ok: false, error: err.message });
    }
  });

  // 做种策略：GET 列表 / GET 生效策略 / POST upsert / DELETE
  app.get('/api/policies', async () => listPolicies());

  app.get('/api/policies/effective', async (req) => {
    const siteId = req.query?.siteId ? Number(req.query.siteId) : 0;
    return getEffectivePolicy(siteId);
  });

  app.post('/api/policies', async (req, reply) => {
    const { siteId = 0, targetRatio = 1.0, minSeedingHours = 72, warnRatio = 1.0 } = req.body ?? {};
    try {
      return await upsertPolicy({
        siteId: Number(siteId),
        targetRatio: Number(targetRatio),
        minSeedingHours: Number(minSeedingHours),
        warnRatio: Number(warnRatio),
      });
    } catch (err) {
      return reply.code(400).send({ ok: false, error: err.message });
    }
  });

  app.delete('/api/policies/:siteId', async (req, reply) => {
    const ok = await deletePolicy(Number(req.params.siteId));
    if (!ok) return reply.code(404).send({ ok: false, error: 'policy not found' });
    return { ok: true };
  });
}
