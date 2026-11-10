import mysql from 'mysql2/promise';
import { config } from '../config.js';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  namedPlaceholders: true,
  charset: 'utf8mb4_general_ci',
});

export async function ping() {
  const [rows] = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}
