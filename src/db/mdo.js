import mysql from 'mysql2/promise';
import { config } from '../config.js';

// moive-database-op 的 MySQL（只读）——用于读取历届获奖片单（movie_info_reference）。
// 与 pt-download 本地库分开连接，避免污染本项目的连接池与命名参数行为。
export const mdoPool = mysql.createPool({
  host: config.mdo.host,
  port: config.mdo.port,
  user: config.mdo.user,
  password: config.mdo.password,
  database: config.mdo.database,
  waitForConnections: true,
  connectionLimit: 3,
  charset: 'utf8mb4_general_ci',
});

export function mdoEnabled() {
  return Boolean(config.mdo.host && config.mdo.user && config.mdo.database);
}
