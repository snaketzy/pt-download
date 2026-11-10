import { config } from '../config.js';
import { normalizeTitle } from '../parsers/title.js';

// M-Team 官方 API 客户端（搜索）。
// 与 NexusPHP RSS 不同：这是主动搜索接口，用于「按 IMDb 反查站内种子」。
// 端点：POST {apiBase}/torrent/search，请求头必须同时带
//   x-api-key + Content-Type + Accept + User-Agent（缺 Accept 会被 nginx 拦成 302）。

const UA = 'pt-download/0.1 (+api)';

// status.discount → 与 rss_items.free_type 同一套枚举
function mapDiscount(discount) {
  switch (String(discount || '').toUpperCase()) {
    case 'FREE':
    case 'PERCENT_100':
      return 'free';
    case '_2X_FREE':
      return 'free2x';
    case '_2X':
    case '_2X_PERCENT_50':
      return '2x';
    default:
      return 'none';
  }
}

function toBytes(value) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : null;
}

function toNum(value) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

function extractImdbId(imdb) {
  if (!imdb) return null;
  const m = String(imdb).match(/(tt\d{5,})/);
  return m ? m[1] : null;
}

// 搜索。imdb 传裸 tt 号即可（接口也接受完整 URL）；keyword 用于中英文片名。
export async function search(
  { keyword, imdb, pageNumber = 1, pageSize = 20, sortField = 'CREATED_DATE', sortType = 'DESC' } = {},
  { timeoutMs = 20000 } = {},
) {
  if (!config.mteam.apiKey) throw new Error('MTEAM_API_KEY 未配置');

  const body = { pageNumber, pageSize, sortField, sortType };
  if (imdb) body.imdb = imdb;
  else if (keyword) body.keyword = keyword;
  else throw new Error('搜索需提供 imdb 或 keyword');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.mteam.apiBase}/torrent/search`, {
      method: 'POST',
      headers: {
        'x-api-key': config.mteam.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': UA,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`M-Team HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== 0 && json.code !== '0') {
      const err = new Error(`M-Team code ${json.code}: ${json.message ?? 'unknown'}`);
      err.apiCode = json.code;
      // code 4 = 請求過於頻繁（触发站点风控），交由上层退避重试
      err.rateLimited = String(json.code) === '4';
      throw err;
    }
    const data = json.data ?? {};
    return {
      total: toNum(data.total),
      pageNumber: toNum(data.pageNumber) || pageNumber,
      pageSize: toNum(data.pageSize) || pageSize,
      totalPages: toNum(data.totalPages),
      items: Array.isArray(data.data) ? data.data : [],
    };
  } finally {
    clearTimeout(timer);
  }
}

// 生成下载直链（带 sign/tid/uid，有时效，需即时交给下载器）。
// 注意：参数必须以 form-urlencoded 提交，用 JSON body 会被判「參數錯誤」。
export async function genDownloadUrl(id, { timeoutMs = 20000 } = {}) {
  if (!config.mteam.apiKey) throw new Error('MTEAM_API_KEY 未配置');
  if (id == null || id === '') throw new Error('生成下载链接需要种子 id');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.mteam.apiBase}/torrent/genDlToken`, {
      method: 'POST',
      headers: {
        'x-api-key': config.mteam.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': UA,
      },
      body: new URLSearchParams({ id: String(id) }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`M-Team HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== 0 && json.code !== '0') {
      const err = new Error(`M-Team code ${json.code}: ${json.message ?? 'unknown'}`);
      err.apiCode = json.code;
      err.rateLimited = String(json.code) === '4';
      throw err;
    }
    if (!json.data) throw new Error('M-Team 未返回下载链接');
    return String(json.data);
  } finally {
    clearTimeout(timer);
  }
}

// 归一化：字段与 RSS 条目对齐（title/sizeBytes/freeType），并附加 M-Team 专属字段。
export function normalizeTorrent(item, { provider = 'mteam' } = {}) {
  const title = String(item?.name ?? '');
  const status = item?.status ?? {};
  const sizeBytes = toBytes(item?.size);
  const parsed = normalizeTitle(title);

  return {
    provider,
    torrentId: item?.id != null ? String(item.id) : null,
    title,
    imdb: extractImdbId(item?.imdb),
    douban: item?.douban ?? null,
    category: item?.category != null ? String(item.category) : null,
    sizeBytes,
    sizeGiB: sizeBytes ? Number((sizeBytes / 1073741824).toFixed(2)) : null,
    freeType: mapDiscount(status.discount),
    discount: status.discount ?? null,
    seeders: toNum(status.seeders),
    leechers: toNum(status.leechers),
    timesCompleted: toNum(status.timesCompleted),
    labels: Array.isArray(item?.labelsNew) ? item.labelsNew : [],
    hasChineseSubtitle: item?.hasChineseSubtitle ?? null,
    publishAt: item?.createdDate ?? null,
    description: item?.smallDescr ?? null,
    poster: Array.isArray(item?.imageList) ? item.imageList[0] ?? null : null,
    parsed,
  };
}
