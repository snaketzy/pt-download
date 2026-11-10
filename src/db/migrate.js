import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { config } from '../config.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

// schema.sql 用的是 CREATE TABLE IF NOT EXISTS，对已存在的表不会补列。
// 这里对新增列做幂等补齐（MySQL 8 不支持 ADD COLUMN IF NOT EXISTS）。
const COLUMN_MIGRATIONS = [
  ['downloads', 'uploaded', 'BIGINT UNSIGNED DEFAULT NULL'],
  ['downloads', 'downloaded', 'BIGINT UNSIGNED DEFAULT NULL'],
  ['downloads', 'progress', 'DECIMAL(5,2) DEFAULT NULL'],
  ['downloads', 'tracker', 'VARCHAR(255) DEFAULT NULL'],
  ['downloads', 'free_type', "ENUM('none','free','2x','free2x') NOT NULL DEFAULT 'none'"],
  ['downloads', 'is_protected', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['downloads', 'completed_at', 'DATETIME DEFAULT NULL'],
  ['downloads', 'last_synced_at', 'DATETIME DEFAULT NULL'],
];

async function ensureColumns() {
  let added = 0;
  for (const [table, column, definition] of COLUMN_MIGRATIONS) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [config.db.database, table, column],
    );
    if (rows[0].c === 0) {
      await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
      added += 1;
    }
  }
  return added;
}

async function main() {
  const sql = fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8');
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await pool.query(statement);
  }
  const added = await ensureColumns();
  console.log(`[migrate] applied ${statements.length} statement(s), ensured ${added} column(s)`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('[migrate] failed:', err.message);
    process.exit(1);
  });
