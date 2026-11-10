import { pool } from '../db/pool.js';

function num(value) {
  return value == null ? null : Number(value);
}

export function parseDownload(row) {
  if (!row) return null;
  return {
    id: row.id,
    hash: row.hash,
    name: row.name,
    ruleId: row.rule_id,
    siteId: row.site_id,
    savePath: row.save_path,
    category: row.category,
    tags: row.tags,
    sizeBytes: num(row.size_bytes),
    state: row.state,
    ratio: num(row.ratio),
    uploaded: num(row.uploaded),
    downloaded: num(row.downloaded),
    progress: num(row.progress),
    tracker: row.tracker,
    freeType: row.free_type,
    isProtected: !!row.is_protected,
    completedAt: row.completed_at,
    lastSyncedAt: row.last_synced_at,
    seedingTime: num(row.seeding_time),
    addedAt: row.added_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = `hash, name, rule_id, site_id, save_path, category, tags, size_bytes, state, ratio,
  uploaded, downloaded, progress, tracker, free_type, is_protected, completed_at, last_synced_at,
  seeding_time, added_at, updated_at`;

export async function listDownloads({ siteId = null, state = null, limit = 500 } = {}) {
  const where = [];
  const params = [];
  if (siteId != null) {
    where.push('site_id = ?');
    params.push(siteId);
  }
  if (state) {
    where.push('state = ?');
    params.push(state);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT ${COLUMNS} FROM downloads ${clause} ORDER BY id DESC LIMIT ?`,
    [...params, Number(limit)],
  );
  return rows.map(parseDownload);
}

export async function getDownloadByHash(hash) {
  const [rows] = await pool.query(`SELECT ${COLUMNS} FROM downloads WHERE hash = ?`, [hash]);
  return parseDownload(rows[0]);
}

// 下发时落库（rule_id / free_type 由本地规则提供，qB 不返回）。
export async function upsertDownload(d = {}) {
  if (!d.hash) throw new Error('download hash is required');
  await pool.query(
    `INSERT INTO downloads (hash, name, rule_id, site_id, save_path, category, tags, size_bytes, state, free_type, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = NOW()`,
    [
      d.hash,
      d.name ?? null,
      d.ruleId ?? null,
      d.siteId ?? null,
      d.savePath ?? null,
      d.category ?? null,
      d.tags ?? null,
      d.sizeBytes ?? null,
      d.state ?? null,
      d.freeType ?? 'none',
    ],
  );
}

// 状态同步：用 qB 的权威字段覆盖统计列；null 的字段不覆盖已有值。
export async function updateSyncedStats(hash, s = {}) {
  await pool.query(
    `UPDATE downloads SET
       name = COALESCE(?, name),
       state = ?,
       ratio = ?,
       uploaded = ?,
       downloaded = ?,
       progress = ?,
       tracker = ?,
       size_bytes = COALESCE(?, size_bytes),
       save_path = COALESCE(?, save_path),
       category = COALESCE(?, category),
       completed_at = COALESCE(?, completed_at),
       seeding_time = ?,
       last_synced_at = NOW()
     WHERE hash = ?`,
    [
      s.name ?? null,
      s.state ?? null,
      s.ratio ?? null,
      s.uploaded ?? null,
      s.downloaded ?? null,
      s.progress ?? null,
      s.tracker ?? null,
      s.sizeBytes ?? null,
      s.savePath ?? null,
      s.category ?? null,
      s.completedAt ?? null,
      s.seedingTime ?? null,
      hash,
    ],
  );
}

export async function removeDownload(hash) {
  const [res] = await pool.query('DELETE FROM downloads WHERE hash = ?', [hash]);
  return res.affectedRows > 0;
}

export async function markProtected(hash, isProtected) {
  await pool.query('UPDATE downloads SET is_protected = ? WHERE hash = ?', [isProtected ? 1 : 0, hash]);
}

// 按站点聚合，用于分享率守卫（ratio = 累计上传 / 累计下载）。
export async function siteStats() {
  const [rows] = await pool.query(
    `SELECT site_id AS siteId,
            COUNT(*) AS torrents,
            COALESCE(SUM(uploaded), 0) AS uploaded,
            COALESCE(SUM(downloaded), 0) AS downloaded,
            COALESCE(SUM(size_bytes), 0) AS sizeBytes
     FROM downloads
     GROUP BY site_id`,
  );
  return rows.map((r) => {
    const uploaded = Number(r.uploaded);
    const downloaded = Number(r.downloaded);
    return {
      siteId: r.siteId,
      torrents: Number(r.torrents),
      uploaded,
      downloaded,
      sizeBytes: Number(r.sizeBytes),
      ratio: downloaded > 0 ? Number((uploaded / downloaded).toFixed(4)) : null,
    };
  });
}
