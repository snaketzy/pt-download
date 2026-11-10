import { config } from './config.js';
import { pool } from './db/pool.js';
import { pollAndDispatch } from './services/poller.js';
import { syncFromQb } from './services/seed.js';

// 进度状态保存在内存：重启后首轮会把所有启用站点视为「到期」并补跑一次，
// 跨轮次去重由 rss_items 唯一键与 matched_items 唯一键兜底，不会重复下载。
const state = {
  enabled: config.poll.enabled,
  tickSec: config.poll.tickSec,
  startedAt: null,
  timer: null,
  running: false,
  lastRunAt: null,
  lastResults: null,
  lastSeedSync: null,
  sites: new Map(), // siteId -> { site, lastPolledAt, ok, ... }
};

export function getSchedulerStatus() {
  return {
    enabled: state.enabled,
    tickSec: state.tickSec,
    running: state.running,
    startedAt: state.startedAt,
    lastRunAt: state.lastRunAt,
    lastResults: state.lastResults,
    lastSeedSync: state.lastSeedSync,
    sites: [...state.sites.entries()].map(([siteId, v]) => ({ siteId, ...v })),
  };
}

// 跑一轮：对「到期」的启用站点依次抓取并下发。force=true 时忽略到期判断。
export async function runTick({ force = false } = {}) {
  if (state.running) return { skipped: true, reason: 'previous tick still running' };
  state.running = true;
  try {
    const [sites] = await pool.query(
      'SELECT id, name, rss_url, poll_interval_sec FROM sites WHERE enabled = 1 AND rss_url IS NOT NULL ORDER BY id',
    );

    const now = Date.now();
    const results = [];

    for (const site of sites) {
      const prev = state.sites.get(site.id);
      const intervalMs = Math.max(60, Number(site.poll_interval_sec) || 600) * 1000;
      if (!force && prev?.lastPolledAt && now - prev.lastPolledAt < intervalMs) {
        results.push({ siteId: site.id, site: site.name, skipped: 'not-due' });
        continue;
      }

      try {
        const r = await pollAndDispatch({ id: site.id, name: site.name, rssUrl: site.rss_url });
        state.sites.set(site.id, {
          site: site.name,
          lastPolledAt: Date.now(),
          ok: true,
          parsed: r.parsed,
          inserted: r.inserted,
          engine: r.engine,
        });
        results.push({ siteId: site.id, site: site.name, ok: true, parsed: r.parsed, inserted: r.inserted, engine: r.engine });
      } catch (err) {
        state.sites.set(site.id, { site: site.name, lastPolledAt: Date.now(), ok: false, error: err.message });
        results.push({ siteId: site.id, site: site.name, ok: false, error: err.message });
      }
    }

    // 每轮向 qB 同步一次做种状态（本地调用，开销小），供分享率/候选/告警使用。
    try {
      state.lastSeedSync = await syncFromQb();
    } catch (err) {
      state.lastSeedSync = { error: err.message };
    }

    state.lastRunAt = new Date().toISOString();
    state.lastResults = results;
    return { skipped: false, at: state.lastRunAt, results, seedSync: state.lastSeedSync };
  } finally {
    state.running = false;
  }
}

export function startScheduler() {
  if (!state.enabled) {
    console.log('[scheduler] 已禁用（POLL_ENABLED=false）');
    return null;
  }
  if (state.timer) return state.timer;

  state.startedAt = new Date().toISOString();
  state.timer = setInterval(() => {
    runTick().catch((err) => console.error('[scheduler] tick failed:', err.message));
  }, state.tickSec * 1000);
  state.timer.unref();
  console.log(`[scheduler] 已启动，检查间隔 ${state.tickSec}s`);
  return state.timer;
}

export function stopScheduler() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.startedAt = null;
}
