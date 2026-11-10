import { XMLParser } from 'fast-xml-parser';
import { parseDescription } from '../parsers/description.js';

// HDHome / HDRoute / TTG / M-Team 均为 NexusPHP 系，RSS 结构基本一致。
// 差异（免费标记、infoHash 是否存在等）通过 detectFree / extractInfohash 兜底。

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => name === 'item',
  // M-Team 的描述块含大量 HTML 实体，默认上限（1000）会误判为实体炸弹，这里放宽。
  processEntities: {
    enabled: true,
    maxTotalExpansions: 200000,
    maxExpandedLength: 5000000,
  },
});

const UA = 'pt-download/0.1 (+rss)';

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(node) {
  if (node == null) return null;
  if (typeof node === 'object') return node['#text'] ?? null;
  return String(node);
}

function toInt(value) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : null;
}

export async function fetchFeed(url, { timeoutMs = 20000 } = {}) {
  if (!url) throw new Error('RSS url is empty');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`RSS fetch failed: HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractInfohash(item, downloadUrl, link) {
  const direct = text(item.torrent?.infoHash) ?? text(item.torrent?.infohash);
  if (direct && /^[0-9a-fA-F]{40}$/.test(direct.trim())) return direct.trim().toLowerCase();
  const haystack = [link, downloadUrl, text(item.description)].filter(Boolean).join(' ');
  const match = haystack.match(/\b[0-9a-fA-F]{40}\b/);
  return match ? match[0].toLowerCase() : null;
}

function detectFree(item, title) {
  const dvf = toInt(text(item.torrent?.downloadvolumefactor) ?? text(item.downloadvolumefactor));
  const uvf = toInt(text(item.torrent?.uploadvolumefactor) ?? text(item.uploadvolumefactor));

  let free = dvf === 0 || /免费|Free(?!leech)/i.test(title);
  let x2 = uvf === 2 || /(?:^|[\s.\[])(?:2X|2倍)(?:[\s.\]]|$)/i.test(title);

  if (free && x2) return 'free2x';
  if (free) return 'free';
  if (x2) return '2x';
  return 'none';
}

function mapItem(item, site) {
  const title = text(item.title);
  if (!title) return null;

  const enclosure = item.enclosure ?? {};
  const downloadUrl = enclosure['@_url'] ?? text(item.link) ?? null;
  const link = text(item.link) ?? null;
  const sizeBytes =
    toInt(enclosure['@_length']) ??
    toInt(text(item.torrent?.size)) ??
    toInt(text(item.size));

  const guid = text(item.guid) ?? link ?? `${title}|${downloadUrl ?? ''}`;
  const pubDate = text(item.pubDate) ?? text(item.published) ?? null;
  const meta = parseDescription(text(item.description));

  return {
    siteId: site?.id ?? null,
    guid: String(guid),
    title,
    downloadUrl,
    link,
    infohash: extractInfohash(item, downloadUrl, link),
    category: text(item.category) ?? null,
    sizeBytes,
    freeType: detectFree(item, title),
    publishAt: pubDate ? new Date(pubDate) : null,
    meta,
    raw: {
      link,
      categoryDomain: item.category?.['@_domain'] ?? null,
      pubDate,
    },
  };
}

export function parseFeed(xml, site) {
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel ?? doc?.feed ?? {};
  return asArray(channel.item)
    .map((item) => mapItem(item, site))
    .filter(Boolean);
}
