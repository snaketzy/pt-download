import 'dotenv/config';

function toInt(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  server: {
    port: toInt(process.env.PORT, 3000),
    logLevel: process.env.LOG_LEVEL || 'info',
  },
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: toInt(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'pt_download',
    connectionLimit: toInt(process.env.DB_CONNECTION_LIMIT, 5),
  },
  qb: {
    baseUrl: (process.env.QB_BASE_URL || 'http://127.0.0.1:8081').replace(/\/+$/, ''),
    apiKey: process.env.QB_API_KEY || '',
    username: process.env.QB_USERNAME || '',
    password: process.env.QB_PASSWORD || '',
  },
  poll: {
    enabled: (process.env.POLL_ENABLED ?? 'true') !== 'false',
    tickSec: Math.max(10, toInt(process.env.POLL_TICK_SEC, 60)),
  },
  mteam: {
    apiKey: process.env.MTEAM_API_KEY || '',
    apiBase: (process.env.MTEAM_API_BASE || 'https://api.m-team.cc/api').replace(/\/+$/, ''),
  },
  mdo: {
    host: process.env.MDO_DB_HOST || '',
    port: toInt(process.env.MDO_DB_PORT, 3306),
    user: process.env.MDO_DB_USER || '',
    password: process.env.MDO_DB_PASSWORD || '',
    database: process.env.MDO_DB_NAME || '',
  },
};
