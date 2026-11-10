import { pool } from '../db/pool.js';
import { normalizeTitle } from '../parsers/title.js';
import { evaluate, buildContext } from './match.js';
import { listRules } from '../repositories/rules.js';
import { fetchFeed, parseFeed } from '../sites/nexusphp.js';
import * as qb from '../services/qbittorrent.js';

// DB 行 → 规则上下文所需的 item 形态（与 pollSite 产出一致）。
export function rowToItem(row) {
  const raw = typeof row.raw_json === 'string' ? safeParse(row.raw_json) : (row.raw_json ?? {});
  return {
    id: row.id,
    siteId: row.site_id,
    siteName: row.site_name ?? null,
    guid: row.guid,
    title: row.title,
    downloadUrl: row.download_url,
    infohash: row.infohash,
    category: row.category,
    sizeBytes: row.size_bytes,
    freeType: row.free_type,
    publishAt: row.publish_at,
    meta: raw?.meta ?? null,
    raw,
    parsed: normalizeTitle(row.title),
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// 读取待评估的 RSS 条目（默认最近 N 条，可按站点/起始 id 过滤）。
export async function loadCandidates({ limit = 200, siteId = null, sinceId = 0 } = {}) {
  const where = [];
  const params = [];
  if (siteId) {
    where.push('r.site_id = ?');
    params.push(siteId);
  }
  if (sinceId) {
    where.push('r.id > ?');
    params.push(sinceId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows] = await pool.query(
    `SELECT r.id, r.site_id, r.guid, r.title, r.download_url, r.infohash, r.category,
            r.size_bytes, r.free_type, r.publish_at, r.raw_json, s.name AS site_name
     FROM rss_items r
     LEFT JOIN sites s ON s.id = r.site_id
     ${clause}
     ORDER BY r.id DESC
     LIMIT ?`,
    [...params, Number(limit)],
  );
  return rows.map(rowToItem);
}

// 规则命中后写 matched_items；唯一键 (rule_id, rss_item_id) 保证只记一次。
// 返回该命中的当前状态，供上层判断是否需要下发（pending = 命中但未下发）。
async function recordMatch(ruleId, rssItemId, { score = 0, reason = null, status = 'pending' } = {}) {
  const [res] = await pool.query(
    `INSERT IGNORE INTO matched_items (rule_id, rss_item_id, score, status, reason)
     VALUES (?, ?, ?, ?, ?)`,
    [ruleId, rssItemId, score, status, reason],
  );
  if (res.affectedRows > 0) return { inserted: true, status };

  const [rows] = await pool.query('SELECT status FROM matched_items WHERE rule_id = ? AND rss_item_id = ?', [
    ruleId,
    rssItemId,
  ]);
  return { inserted: false, status: rows[0]?.status ?? null };
}

async function setMatchStatus(ruleId, rssItemId, status, reason = null) {
  await pool.query('UPDATE matched_items SET status = ?, reason = ? WHERE rule_id = ? AND rss_item_id = ?', [
    status,
    reason,
    ruleId,
    rssItemId,
  ]);
}

async function logHistory(type, message, payload) {
  await pool.query('INSERT INTO history (type, message, payload_json) VALUES (?, ?, CAST(? AS JSON))', [
    type,
    message,
    JSON.stringify(payload ?? null),
  ]);
}

async function saveDownload(rule, item, state) {
  if (!item.infohash) return;
  await pool.query(
    `INSERT INTO downloads (hash, name, rule_id, site_id, save_path, category, tags, size_bytes, state, free_type, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = NOW()`,
    [
      item.infohash,
      item.title,
      rule.id,
      item.siteId,
      rule.action?.savePath ?? null,
      rule.action?.category ?? null,
      Array.isArray(rule.action?.tags) ? rule.action.tags.join(',') : (rule.action?.tags ?? null),
      item.sizeBytes ?? null,
      state,
      item.freeType ?? 'none',
    ],
  );
}

// 站点的下载链接是「带时间签名」的，入库时的 URL 到下发时已过期（返回 JSON 报错而非种子）。
// 下发前重新抓一次该站 RSS，用最新签发的链接替换，key 为 siteId:guid。
async function refreshDownloadUrls(items) {
  const siteIds = [...new Set(items.map((it) => it.siteId).filter(Boolean))];
  const fresh = new Map();
  if (!siteIds.length) return fresh;

  const [sites] = await pool.query('SELECT id, name, rss_url FROM sites WHERE id IN (?)', [siteIds]);
  for (const site of sites) {
    if (!site.rss_url) continue;
    try {
      const xml = await fetchFeed(site.rss_url);
      for (const it of parseFeed(xml, { id: site.id, name: site.name })) {
        if (it.downloadUrl) fresh.set(`${site.id}:${it.guid}`, it.downloadUrl);
      }
    } catch {
      // 刷新失败则回退到库里的旧链接，让下发流程继续（失败会被记为 failed）。
    }
  }
  return fresh;
}

// qB 对「URL 抓取失败」也会返回 "Ok."，且会按种子内部名重命名任务，无法靠标题比对。
// 改为记录添加前的 hash 集合，添加后轮询找出「新出现的任务」即本次真正添加的种子。
async function waitForNewTorrent(before, { tries = 12, delayMs = 700 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    await new Promise((r) => setTimeout(r, delayMs));
    const list = await qb.listTorrents({ filter: 'all' });
    const fresh = list.find((t) => !before.has(t.hash));
    if (fresh) return fresh;
  }
  return null;
}

// 把命中条目下发到 qBittorrent。
async function dispatch(rule, item) {
  const action = rule.action ?? {};
  try {
    const before = new Set((await qb.listTorrents({ filter: 'all' })).map((t) => t.hash));

    await qb.addTorrent({
      urls: item.downloadUrl,
      savePath: action.savePath,
      category: action.category,
      tags: action.tags,
      paused: action.paused ?? false,
    });

    const added = await waitForNewTorrent(before);
    if (!added) throw new Error('qB 未确认添加（下载链接可能失效或种子无效）');

    item.infohash = added.hash; // 用 qB 回传的真实 infohash 落库
    await setMatchStatus(rule.id, item.id, 'downloaded', null);
    await saveDownload(rule, item, 'downloading');
    await logHistory('download', `${rule.name} → ${item.title}`, {
      ruleId: rule.id,
      rssItemId: item.id,
      hash: added.hash,
    });
    return { ok: true };
  } catch (err) {
    await setMatchStatus(rule.id, item.id, 'failed', String(err.message).slice(0, 255));
    await logHistory('error', `下发失败: ${item.title}`, { ruleId: rule.id, error: err.message });
    return { ok: false, error: err.message };
  }
}

// 评估所有启用规则：命中 → 记 matched_items（→ 非 dryRun 时下发 qB）。
export async function runRules({ dryRun = false, limit = 200, siteId = null, sinceId = 0, ruleIds = null } = {}) {
  const rules = (await listRules({ enabledOnly: true })).filter(
    (r) => !ruleIds || ruleIds.includes(r.id),
  );
  const candidates = await loadCandidates({ limit, siteId, sinceId });

  const summary = { rules: rules.length, candidates: candidates.length, matched: 0, inserted: 0, dispatched: 0, failed: 0, dryRun };

  // 一阶段：评估所有规则并记录命中，收集待下发项（pending）。
  const pending = [];
  for (const rule of rules) {
    for (const item of candidates) {
      const ctx = buildContext(item);
      if (!evaluate(rule.match, ctx)) continue;

      summary.matched += 1;
      const rec = await recordMatch(rule.id, item.id, { reason: 'matched' });
      if (rec.inserted) summary.inserted += 1;

      // 仅下发尚未处理的命中；已 downloaded/failed/skipped 的不重复下发。
      if (!dryRun && rec.status === 'pending') pending.push({ rule, item });
    }
  }

  // 二阶段：刷新下载链接后统一下发。
  if (pending.length) {
    const fresh = await refreshDownloadUrls(pending.map((p) => p.item));
    for (const { rule, item } of pending) {
      const downloadUrl = fresh.get(`${item.siteId}:${item.guid}`) ?? item.downloadUrl;
      const res = await dispatch(rule, { ...item, downloadUrl });
      if (res.ok) summary.dispatched += 1;
      else summary.failed += 1;
    }
  }

  if (!dryRun) {
    await logHistory('engine_run', `规则评估完成 matched=${summary.matched} dispatched=${summary.dispatched}`, summary);
  }
  return summary;
}
