import { normalizeTitle } from '../parsers/title.js';

export function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function getPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function compareEq(actual, expect) {
  if (typeof actual === 'string' && typeof expect === 'string') {
    return actual.toLowerCase() === expect.toLowerCase();
  }
  return actual === expect;
}

function isPresent(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.length > 0;
  return true;
}

function evaluateLeaf(node, ctx) {
  const actual = getPath(ctx, node.field);
  const op = String(node.op || 'eq').toLowerCase();
  const expect = node.value;

  switch (op) {
    case 'eq':
      return compareEq(actual, expect);
    case 'ne':
      return !compareEq(actual, expect);
    case 'in':
      return toArray(expect).some((v) => compareEq(actual, v));
    case 'nin':
      return !toArray(expect).some((v) => compareEq(actual, v));
    case 'regex':
      return typeof actual === 'string' && new RegExp(String(expect), node.flags || 'i').test(actual);
    case 'gt':
      return num(actual) > num(expect);
    case 'gte':
      return num(actual) >= num(expect);
    case 'lt':
      return num(actual) < num(expect);
    case 'lte':
      return num(actual) <= num(expect);
    case 'hasAny':
      return toArray(actual).some((a) => toArray(expect).some((e) => compareEq(a, e)));
    case 'hasAll': {
      const wanted = toArray(expect);
      return wanted.length > 0 && wanted.every((e) => toArray(actual).some((a) => compareEq(a, e)));
    }
    case 'contains':
      return Array.isArray(actual)
        ? actual.some((a) => String(a).includes(String(expect)))
        : String(actual ?? '').includes(String(expect));
    case 'exists':
      return isPresent(actual);
    case 'notExists':
      return !isPresent(actual);
    default:
      return false;
  }
}

// 递归求值。节点形态：
//   分组：{ op: 'and' | 'or' | 'not', conditions: [ ... ] }
//   叶子：{ field, op, value }
export function evaluate(node, ctx) {
  if (!node || typeof node !== 'object') return false;

  const op = String(node.op || 'and').toLowerCase();
  if (op === 'and' || op === 'or') {
    const conds = node.conditions ?? [];
    if (!conds.length) return op === 'and';
    return op === 'and' ? conds.every((c) => evaluate(c, ctx)) : conds.some((c) => evaluate(c, ctx));
  }
  if (op === 'not') {
    const conds = node.conditions ?? [];
    return !conds.some((c) => evaluate(c, ctx));
  }
  return evaluateLeaf(node, ctx);
}

// 把一条 RSS 条目归一化为规则可引用的上下文。
export function buildContext(item) {
  const parsed = item.parsed ?? normalizeTitle(item.title);
  const meta = item.meta ?? {};
  const markers = Object.keys(parsed.markers ?? {}).filter((k) => parsed.markers[k]);

  return {
    title: item.title,
    cleanTitle: parsed.cleanTitle ?? null,
    category: item.category ?? null,
    sizeBytes: item.sizeBytes ?? null,
    sizeGiB: item.sizeBytes ? Number((item.sizeBytes / 1073741824).toFixed(2)) : null,
    freeType: item.freeType ?? 'none',
    isFree: item.freeType === 'free' || item.freeType === 'free2x',
    infohash: item.infohash ?? null,
    siteId: item.siteId ?? null,
    siteName: item.siteName ?? null,

    resolution: parsed.resolution ?? null,
    source: parsed.source ?? null,
    codec: parsed.codec ?? null,
    audio: parsed.audio ?? null,
    group: parsed.group ?? null,
    year: parsed.year ?? null,
    season: parsed.season ?? null,
    episode: parsed.episode ?? null,
    hdr: parsed.hdr ?? [],
    markers,

    meta,
    titleCn: meta.titleCn ?? null,
    titleOriginal: meta.titleOriginal ?? null,
    aliases: meta.aliases ?? [],
    languages: meta.languages ?? [],
    regions: meta.regions ?? [],
    genres: meta.genres ?? [],
    imdb: meta.imdb ?? null,
    douban: meta.douban ?? null,
    tmdb: meta.tmdb ?? null,
  };
}
