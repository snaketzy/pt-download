import { mdoPool, mdoEnabled } from '../db/mdo.js';
import { search as mteamSearch, normalizeTorrent, genDownloadUrl } from '../sites/mteam.js';
import { upsertDownload } from '../repositories/downloads.js';
import * as qb from './qbittorrent.js';

// 「搜索 + 预览」：从 mdo 库读取获奖片单，逐条按 IMDb 到 M-Team 反查候选种子。
// 搜索只读不下发；点到具体候选时，走 downloadCandidate 单条下发（需用户显式点击）。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// M-Team 搜索接口风控很严（code 4「請求過於頻繁」，恢复窗口可达数十秒）。
// 固定间隔治不了：撞限流时把全局间隔翻倍，成功时缓慢回收，自适应逼近可持续速率。
function createGate(initialMs) {
  let interval = initialMs;
  let nextAt = 0;
  return {
    async wait() {
      const now = Date.now();
      const gap = Math.max(0, nextAt - now);
      nextAt = Math.max(now, nextAt) + interval;
      if (gap > 0) await sleep(gap);
    },
    penalize() {
      interval = Math.min(interval * 2, 15000);
    },
    relax() {
      interval = Math.max(initialMs, interval * 0.85);
    },
    get interval() {
      return Math.round(interval);
    },
  };
}

// 每次尝试都先过闸；命中限流则加倍全局间隔并退避重试。
async function gatedRetry(gate, fn, { attempts = 5, baseDelayMs = 2500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    await gate.wait();
    try {
      const out = await fn();
      gate.relax();
      return out;
    } catch (err) {
      lastErr = err;
      if (!err.rateLimited) throw err;
      gate.penalize();
      if (i === attempts - 1) break;
      await sleep(Math.min(baseDelayMs * 2 ** i, 20000) + Math.floor(Math.random() * 800));
    }
  }
  throw lastErr;
}

// 简单并发闸。
async function mapLimit(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(concurrency, items.length || 1));
  async function run() {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: size }, run));
  return results;
}

// 读取片单：movie_info_reference 中某奖项/结果下的全部影片（按年份）。
// 同一 IMDb 可能有多行（如新补的「【奥斯卡最佳影片】」行 + 既有行），按 IMDb 去重。
export async function listAwardTitles({ award = '奥斯卡', status = '获奖' } = {}) {
  if (!mdoEnabled()) throw new Error('MDO_DB_HOST / MDO_DB_USER / MDO_DB_NAME 未配置');

  const [rows] = await mdoPool.query(
    'SELECT raw_filename, imdb_id, chinese_title, release_year FROM movie_info_reference ' +
      "WHERE award_list = ? AND award_status = ? AND imdb_id IS NOT NULL AND imdb_id <> '' " +
      'ORDER BY release_year ASC',
    [award, status],
  );

  const byImdb = new Map();
  for (const r of rows) {
    const cur = byImdb.get(r.imdb_id);
    const item = {
      rawFilename: r.raw_filename,
      imdb: r.imdb_id,
      chineseTitle: r.chinese_title ?? null,
      releaseYear: r.release_year ?? null,
    };
    // 去重时优先保留带中文名的一条
    if (!cur || (!cur.chineseTitle && item.chineseTitle)) byImdb.set(r.imdb_id, item);
  }
  return [...byImdb.values()];
}

// 片单维度取值（奖项 award_list / 结果 award_status），按出现次数排序，供前端下拉使用。
// 结果按奖项分组：选中奖项后只展示该奖项实际存在的结果，避免出现空组合。
export async function listFacets() {
  if (!mdoEnabled()) throw new Error('MDO_DB_HOST / MDO_DB_USER / MDO_DB_NAME 未配置');

  const [rows] = await mdoPool.query(
    'SELECT award_list, award_status, COUNT(*) AS c FROM movie_info_reference ' +
      "WHERE award_list IS NOT NULL AND award_list <> '' AND award_status IS NOT NULL AND award_status <> '' " +
      'GROUP BY award_list, award_status ORDER BY c DESC',
  );

  const byAward = new Map();
  for (const r of rows) {
    if (!byAward.has(r.award_list)) byAward.set(r.award_list, { value: r.award_list, count: 0, statuses: [] });
    const award = byAward.get(r.award_list);
    award.count += Number(r.c);
    award.statuses.push({ value: r.award_status, count: Number(r.c) });
  }

  return { ok: true, awards: [...byAward.values()].sort((a, b) => b.count - a.count) };
}

// 逐条搜索并聚合。支持 limit/offset 分批，便于前端渐进渲染。
export async function searchAwardWinners({
  award = '奥斯卡',
  status = '获奖',
  limit = null,
  offset = 0,
  perTitle = 8,
  maxPages = 1,
  minSeeders = 0,
  concurrency = 1,
  minIntervalMs = 1200,
} = {}) {
  const all = await listAwardTitles({ award, status });
  const batch = all.slice(offset, limit == null ? all.length : offset + Number(limit));

  const gate = createGate(minIntervalMs);
  const results = await mapLimit(batch, concurrency, async (t) => {
    const base = {
      imdb: t.imdb,
      chineseTitle: t.chineseTitle,
      releaseYear: t.releaseYear,
      rawFilename: t.rawFilename,
    };

    try {
      const candidates = [];
      for (let page = 1; page <= Math.max(1, maxPages); page += 1) {
        const pageRes = await gatedRetry(gate, () =>
          mteamSearch({ imdb: t.imdb, pageNumber: page, pageSize: perTitle }),
        );
        for (const item of pageRes.items) {
          const norm = normalizeTorrent(item);
          if (norm.seeders >= minSeeders) candidates.push(norm);
        }
        if (page >= pageRes.totalPages) break;
      }
      return { ...base, found: candidates.length > 0, candidateCount: candidates.length, candidates };
    } catch (err) {
      return { ...base, found: false, candidateCount: 0, candidates: [], error: err.message };
    }
  });

  return {
    ok: true,
    provider: 'mteam',
    award,
    status,
    total: all.length,
    offset,
    count: batch.length,
    interval: gate.interval,
    found: results.filter((r) => r.found).length,
    missing: results.filter((r) => !r.found && !r.error).length,
    errored: results.filter((r) => r.error).length,
    totalCandidates: results.reduce((sum, r) => sum + r.candidateCount, 0),
    results,
  };
}

// qB 对「URL 抓取失败」也会返回 "Ok."，且会按种子内部名重命名任务，无法靠添加返回值确认。
// 记录添加前的 hash 集合，添加后轮询找出「新出现的任务」；若已存在该资源则不出现新任务，按名字兜底。
async function waitForTorrentAdded(before, title, { tries = 12, delayMs = 700 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    await sleep(delayMs);
    const list = await qb.listTorrents({ filter: 'all' });
    const fresh = list.find((t) => !before.has(t.hash));
    if (fresh) return fresh;
  }
  if (!title) return null;
  const list = await qb.listTorrents({ filter: 'all' });
  return list.find((t) => t.name === title) ?? null;
}

// 手动下发单个候选：M-Team 生成带签名的下载直链 → 交给 qB → 写入 downloads 表。
// 与规则引擎的 dispatch 不同：条目来自主动搜索而非 RSS，没有 rss_item_id，
// 因此只落 downloads，不写 matched_items（后者唯一键依赖 rule_id + rss_item_id）。
export async function downloadCandidate({
  torrentId,
  title = null,
  sizeBytes = null,
  freeType = 'none',
  savePath = null,
  category = null,
  tags = null,
} = {}) {
  if (!torrentId) throw new Error('缺少 torrentId');

  const url = await genDownloadUrl(torrentId);

  const before = new Set((await qb.listTorrents({ filter: 'all' })).map((t) => t.hash));
  await qb.addTorrent({ urls: url, savePath, category, tags, paused: false });

  const added = await waitForTorrentAdded(before, title);
  if (!added) throw new Error('qB 未确认添加（下载链接可能已失效或种子无效）');

  await upsertDownload({
    hash: added.hash,
    name: added.name || title,
    ruleId: null,
    siteId: null,
    savePath: savePath ?? added.save_path ?? null,
    category: category ?? added.category ?? null,
    tags: Array.isArray(tags) ? tags.join(',') : tags,
    sizeBytes: sizeBytes ?? added.size ?? null,
    state: 'downloading',
    freeType,
  });

  return { ok: true, hash: added.hash, name: added.name || title };
}
