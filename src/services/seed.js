import { pool } from '../db/pool.js';
import * as qb from './qbittorrent.js';
import * as downloads from '../repositories/downloads.js';
import { getEffectivePolicy, listPolicies } from '../repositories/policies.js';

// qB 中「已下载完、正在做种」的状态集合（含暂停/排队/校验）。
const SEEDING_STATES = new Set(['uploading', 'stalledUP', 'queuedUP', 'forcedUP', 'pausedUP', 'checkingUP']);

function isSeeding(state) {
  return SEEDING_STATES.has(state);
}

// qB torrent → downloads 统计字段
function mapTorrent(t) {
  return {
    name: t.name ?? null,
    state: t.state ?? null,
    ratio: Number.isFinite(t.ratio) ? t.ratio : null,
    uploaded: t.uploaded ?? null,
    downloaded: t.downloaded ?? null,
    progress: t.progress != null ? Number((t.progress * 100).toFixed(2)) : null,
    tracker: t.tracker ?? null,
    sizeBytes: t.size ?? null,
    savePath: t.save_path ?? null,
    category: t.category || null,
    seedingTime: t.seeding_time ?? null,
    completedAt: t.completion_on > 0 ? new Date(t.completion_on * 1000) : null,
  };
}

async function logHistory(type, message, payload) {
  await pool.query('INSERT INTO history (type, message, payload_json) VALUES (?, ?, CAST(? AS JSON))', [
    type,
    message,
    JSON.stringify(payload ?? null),
  ]);
}

// 从 qB 同步权威状态：新增/更新统计，并清掉库中已不存在的任务。
export async function syncFromQb() {
  const torrents = await qb.listTorrents({ filter: 'all' });
  const seen = new Set();
  let inserted = 0;
  let updated = 0;
  let removed = 0;

  for (const t of torrents) {
    seen.add(t.hash);
    const existing = await downloads.getDownloadByHash(t.hash);
    if (existing) {
      await downloads.updateSyncedStats(t.hash, mapTorrent(t));
      updated += 1;
    } else {
      await downloads.upsertDownload({
        hash: t.hash,
        name: t.name,
        state: t.state,
        sizeBytes: t.size,
        savePath: t.save_path,
        category: t.category || null,
      });
      await downloads.updateSyncedStats(t.hash, mapTorrent(t));
      inserted += 1;
    }
  }

  const local = await downloads.listDownloads({ limit: 10000 });
  for (const d of local) {
    if (!seen.has(d.hash)) {
      await downloads.removeDownload(d.hash);
      removed += 1;
    }
  }

  const summary = { total: torrents.length, inserted, updated, removed };
  await logHistory('seed_sync', `同步 torrents=${summary.total} +${inserted} ~${updated} -${removed}`, summary);
  return summary;
}

// 计算「可清理」候选：不自动动作，仅供人工确认。
export async function computeCandidates({ siteId = null } = {}) {
  const items = await downloads.listDownloads({ siteId, limit: 5000 });
  const policyCache = new Map();
  async function policyFor(id) {
    if (!policyCache.has(id)) policyCache.set(id, await getEffectivePolicy(id));
    return policyCache.get(id);
  }

  const candidates = [];
  for (const d of items) {
    if (d.isProtected) continue;
    if (!isSeeding(d.state)) continue;

    const policy = await policyFor(d.siteId ?? 0);
    const seedingHours = Number(((d.seedingTime ?? 0) / 3600).toFixed(2));
    const ratioOk = d.ratio != null && d.ratio >= policy.targetRatio;
    const timeOk = seedingHours >= policy.minSeedingHours;
    if (!ratioOk || !timeOk) continue;

    candidates.push({
      hash: d.hash,
      name: d.name,
      siteId: d.siteId,
      state: d.state,
      ratio: d.ratio,
      seedingHours,
      sizeBytes: d.sizeBytes,
      freeType: d.freeType,
      policy: { targetRatio: policy.targetRatio, minSeedingHours: policy.minSeedingHours },
      reasons: [`分享率 ${d.ratio} ≥ ${policy.targetRatio}`, `做种 ${seedingHours}h ≥ ${policy.minSeedingHours}h`],
    });
  }
  return candidates;
}

// 站点维度状态 + 分享率告警（仅告警，不改动下载）。
export async function getSeedStatus() {
  const [stats, policies, sites] = await Promise.all([
    downloads.siteStats(),
    listPolicies(),
    pool.query('SELECT id, name FROM sites').then(([rows]) => rows),
  ]);

  const nameMap = new Map(sites.map((s) => [s.id, s.name]));
  const policyMap = new Map(policies.map((p) => [p.siteId, p]));
  const globalPolicy = policyMap.get(0) ?? null;

  const effCache = new Map();
  async function effective(siteId) {
    if (!effCache.has(siteId)) effCache.set(siteId, await getEffectivePolicy(siteId));
    return effCache.get(siteId);
  }

  const perSite = [];
  for (const s of stats) {
    const policy = await effective(s.siteId ?? 0);
    const alert = s.ratio != null && s.ratio < policy.warnRatio;
    perSite.push({
      siteId: s.siteId,
      siteName: s.siteId == null ? '(未知站点)' : nameMap.get(s.siteId) ?? null,
      torrents: s.torrents,
      uploaded: s.uploaded,
      downloaded: s.downloaded,
      sizeBytes: s.sizeBytes,
      ratio: s.ratio,
      policy: { targetRatio: policy.targetRatio, minSeedingHours: policy.minSeedingHours, warnRatio: policy.warnRatio },
      alert,
      alertMessage: alert ? `分享率 ${s.ratio} 低于告警阈值 ${policy.warnRatio}` : null,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    globalPolicy,
    sites: perSite,
    alerts: perSite.filter((s) => s.alert).map((s) => ({ siteId: s.siteId, siteName: s.siteName, ratio: s.ratio, message: s.alertMessage })),
  };
}

// 人工确认后执行清理：apply 前重新校验候选资格，避免误删（force 可跳过校验）。
export async function applyCleanup({ hashes, deleteFiles = false, force = false } = {}) {
  const list = Array.isArray(hashes) ? hashes.filter(Boolean) : [];
  if (!list.length) throw new Error('hashes is required');

  const candidates = await computeCandidates();
  const allowed = new Set(candidates.map((c) => c.hash));
  const approved = [];
  const rejected = [];

  for (const hash of list) {
    if (force || allowed.has(hash)) approved.push(hash);
    else rejected.push({ hash, reason: '未满足清理条件（分享率/做种时长/受保护）' });
  }

  if (approved.length) {
    await qb.deleteTorrents(approved, { deleteFiles });
    for (const hash of approved) await downloads.removeDownload(hash);
    await logHistory('seed_cleanup', `清理 ${approved.length} 个种子 (deleteFiles=${deleteFiles})`, { approved, rejected });
  }

  return { deleted: approved.length, rejected };
}
