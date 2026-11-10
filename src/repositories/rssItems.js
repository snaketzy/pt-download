import { pool } from '../db/pool.js';

// 幂等入库：唯一键 (site_id, guid) 冲突时跳过，返回新增条数。
export async function saveItems(siteId, items) {
  if (!items.length) return { inserted: 0, total: 0 };

  const rows = items.map((it) => [
    siteId,
    it.guid,
    it.title,
    it.downloadUrl ?? null,
    it.infohash ?? null,
    it.category ?? null,
    it.sizeBytes ?? null,
    it.freeType ?? 'none',
    it.publishAt ?? null,
    JSON.stringify({ ...(it.raw ?? {}), meta: it.meta ?? null }),
  ]);

  const [result] = await pool.query(
    `INSERT IGNORE INTO rss_items
       (site_id, guid, title, download_url, infohash, category, size_bytes, free_type, publish_at, raw_json)
     VALUES ?`,
    [rows],
  );

  return { inserted: result.affectedRows, total: items.length };
}
