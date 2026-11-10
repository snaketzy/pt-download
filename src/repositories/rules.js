import { pool } from '../db/pool.js';

// match_json / action_json 在 DB 里是 JSON 列，mysql2 可能返回字符串或对象，统一解析。
function decode(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

export function parseRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    enabled: !!row.enabled,
    priority: row.priority,
    match: decode(row.match_json),
    action: decode(row.action_json) ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listRules({ enabledOnly = false } = {}) {
  const where = enabledOnly ? 'WHERE enabled = 1' : '';
  const [rows] = await pool.query(
    `SELECT id, name, enabled, priority, match_json, action_json, created_at, updated_at
     FROM rules ${where} ORDER BY priority ASC, id ASC`,
  );
  return rows.map(parseRule);
}

export async function getRule(id) {
  const [rows] = await pool.query(
    `SELECT id, name, enabled, priority, match_json, action_json, created_at, updated_at
     FROM rules WHERE id = ?`,
    [id],
  );
  return parseRule(rows[0]);
}

// 按 name 幂等 upsert（rules.name 有唯一键）。
export async function upsertRule({ name, enabled = true, priority = 100, match, action }) {
  if (!name) throw new Error('rule name is required');
  if (!match || typeof match !== 'object') throw new Error('rule match must be an object');

  const [res] = await pool.query(
    `INSERT INTO rules (name, enabled, priority, match_json, action_json)
     VALUES (?, ?, ?, CAST(? AS JSON), CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE
       enabled = VALUES(enabled),
       priority = VALUES(priority),
       match_json = VALUES(match_json),
       action_json = VALUES(action_json)`,
    [name, enabled ? 1 : 0, priority, JSON.stringify(match), JSON.stringify(action ?? {})],
  );

  const id = res.insertId || (await getIdByName(name));
  return getRule(id);
}

export async function updateRule(id, patch = {}) {
  const current = await getRule(id);
  if (!current) return null;
  const next = {
    name: patch.name ?? current.name,
    enabled: patch.enabled ?? current.enabled,
    priority: patch.priority ?? current.priority,
    match: patch.match ?? current.match,
    action: patch.action ?? current.action,
  };
  await pool.query(
    `UPDATE rules SET name = ?, enabled = ?, priority = ?, match_json = CAST(? AS JSON), action_json = CAST(? AS JSON)
     WHERE id = ?`,
    [next.name, next.enabled ? 1 : 0, next.priority, JSON.stringify(next.match), JSON.stringify(next.action), id],
  );
  return getRule(id);
}

export async function deleteRule(id) {
  const [res] = await pool.query('DELETE FROM rules WHERE id = ?', [id]);
  return res.affectedRows > 0;
}

async function getIdByName(name) {
  const [rows] = await pool.query('SELECT id FROM rules WHERE name = ?', [name]);
  return rows[0]?.id ?? null;
}
