import { pool } from '../db/pool.js';
import { getRule, listRules, upsertRule, updateRule, deleteRule } from '../repositories/rules.js';
import { loadCandidates, rowToItem, runRules } from '../engine/runner.js';
import { evaluate, buildContext } from '../engine/match.js';

export default async function rulesRoutes(app) {
  app.get('/api/rules', async () => listRules());

  app.get('/api/rules/:id', async (req, reply) => {
    const rule = await getRule(req.params.id);
    if (!rule) return reply.code(404).send({ ok: false, error: 'rule not found' });
    return rule;
  });

  app.post('/api/rules', async (req, reply) => {
    const { name, enabled, priority, match, action } = req.body ?? {};
    if (!name) return reply.code(400).send({ ok: false, error: 'name is required' });
    if (!match) return reply.code(400).send({ ok: false, error: 'match is required' });
    try {
      const rule = await upsertRule({ name, enabled, priority, match, action });
      return { ok: true, rule };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: err.message });
    }
  });

  app.put('/api/rules/:id', async (req, reply) => {
    const rule = await updateRule(req.params.id, req.body ?? {});
    if (!rule) return reply.code(404).send({ ok: false, error: 'rule not found' });
    return { ok: true, rule };
  });

  app.delete('/api/rules/:id', async (req, reply) => {
    const ok = await deleteRule(req.params.id);
    if (!ok) return reply.code(404).send({ ok: false, error: 'rule not found' });
    return { ok: true };
  });

  // 用单条 RSS 条目试跑某规则，返回是否命中及归一化上下文，便于调试。
  app.post('/api/rules/:id/test', async (req, reply) => {
    const rule = await getRule(req.params.id);
    if (!rule) return reply.code(404).send({ ok: false, error: 'rule not found' });

    const { rssItemId } = req.body ?? {};
    if (!rssItemId) return reply.code(400).send({ ok: false, error: 'rssItemId is required' });

    const [rows] = await pool.query(
      `SELECT r.id, r.site_id, r.guid, r.title, r.download_url, r.infohash, r.category,
              r.size_bytes, r.free_type, r.publish_at, r.raw_json, s.name AS site_name
       FROM rss_items r LEFT JOIN sites s ON s.id = r.site_id WHERE r.id = ?`,
      [rssItemId],
    );
    if (!rows[0]) return reply.code(404).send({ ok: false, error: 'rss item not found' });

    const item = rowToItem(rows[0]);
    const ctx = buildContext(item);
    return { ok: true, matched: evaluate(rule.match, ctx), ctx };
  });

  // 手动触发一次规则评估（可 dryRun 只记录不下发）。
  app.post('/api/engine/run', async (req) => {
    const { dryRun = false, limit = 200, siteId = null, sinceId = 0 } = req.body ?? {};
    const summary = await runRules({ dryRun: !!dryRun, limit, siteId, sinceId });
    return { ok: true, summary };
  });

  app.get('/api/matched', async (req) => {
    const { status = '', ruleId = '', limit = 100 } = req.query ?? {};
    const where = [];
    const params = [];
    if (status) {
      where.push('m.status = ?');
      params.push(status);
    }
    if (ruleId) {
      where.push('m.rule_id = ?');
      params.push(ruleId);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT m.id, m.rule_id, r.name AS rule_name, m.rss_item_id, i.title, i.download_url,
              i.size_bytes, i.free_type, s.name AS site_name, m.status, m.reason, m.created_at
       FROM matched_items m
       JOIN rss_items i ON i.id = m.rss_item_id
       JOIN rules r ON r.id = m.rule_id
       LEFT JOIN sites s ON s.id = i.site_id
       ${clause}
       ORDER BY m.id DESC
       LIMIT ?`,
      [...params, Number(limit)],
    );
    return rows;
  });

  // 列出候选条目（供调试/手选）。
  app.get('/api/candidates', async (req) => {
    const { limit = 50, siteId = null, sinceId = 0 } = req.query ?? {};
    const items = await loadCandidates({ limit: Number(limit), siteId, sinceId: Number(sinceId) });
    return items.map((it) => ({ id: it.id, title: it.title, siteName: it.siteName, freeType: it.freeType, sizeBytes: it.sizeBytes }));
  });
}
