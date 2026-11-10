import { pool } from '../db/pool.js';

// site_id = 0 为全局默认，其余为站点覆盖。
export const DEFAULT_POLICY = { siteId: 0, targetRatio: 1.0, minSeedingHours: 72, warnRatio: 1.0 };

export function parsePolicy(row) {
  if (!row) return null;
  return {
    id: row.id ?? null,
    siteId: Number(row.site_id ?? 0),
    targetRatio: Number(row.target_ratio ?? DEFAULT_POLICY.targetRatio),
    minSeedingHours: Number(row.min_seeding_hours ?? DEFAULT_POLICY.minSeedingHours),
    warnRatio: Number(row.warn_ratio ?? DEFAULT_POLICY.warnRatio),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export async function listPolicies() {
  const [rows] = await pool.query('SELECT * FROM seed_policies ORDER BY site_id ASC');
  return rows.map(parsePolicy);
}

export async function getPolicy(siteId = 0) {
  const [rows] = await pool.query('SELECT * FROM seed_policies WHERE site_id = ?', [siteId]);
  return parsePolicy(rows[0]);
}

// 站点覆盖 → 全局默认 → 内置默认
export async function getEffectivePolicy(siteId = 0) {
  if (siteId) {
    const own = await getPolicy(siteId);
    if (own) return own;
  }
  return (await getPolicy(0)) ?? parsePolicy({ site_id: 0 });
}

export async function upsertPolicy({ siteId = 0, targetRatio = 1.0, minSeedingHours = 72, warnRatio = 1.0 }) {
  await pool.query(
    `INSERT INTO seed_policies (site_id, target_ratio, min_seeding_hours, warn_ratio)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       target_ratio = VALUES(target_ratio),
       min_seeding_hours = VALUES(min_seeding_hours),
       warn_ratio = VALUES(warn_ratio)`,
    [siteId, targetRatio, minSeedingHours, warnRatio],
  );
  return getPolicy(siteId);
}

export async function deletePolicy(siteId) {
  const [res] = await pool.query('DELETE FROM seed_policies WHERE site_id = ?', [siteId]);
  return res.affectedRows > 0;
}
