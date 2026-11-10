// 解析 NexusPHP 系站点的种⼦描述（◎ 字段块），提取中文元数据。
// M-Team / HDHome 等站点的 description 均为此格式，可支撑「语言/产地」等精确过滤。

const LABELS = [
  { re: /^译\s*名/, field: 'aliases' },
  { re: /^片\s*名/, field: 'titleCn' },
  { re: /^原\s*名/, field: 'titleOriginal' },
  { re: /^年\s*代/, field: 'year' },
  { re: /^产\s*地/, field: 'regions' },
  { re: /^类\s*别/, field: 'genres' },
  { re: /^语\s*言/, field: 'languages' },
  { re: /^片\s*长/, field: 'runtime' },
  { re: /^IMDb/, field: 'imdb' },
  { re: /^豆瓣/, field: 'douban' },
  { re: /^TMDB/, field: 'tmdb' },
];

const LIST_FIELDS = new Set(['aliases', 'regions', 'genres', 'languages']);

function splitList(value) {
  return value
    .replace(/\([^)]*\)/g, '')
    .split(/\s*[/、,]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripHtml(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|q)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
}

export function parseDescription(html) {
  if (!html) return null;

  const out = {};
  for (const rawLine of stripHtml(html).split('\n')) {
    const line = rawLine.replace(/\u00a0/g, ' ').trim();
    if (!line.startsWith('◎')) continue;

    const body = line.slice(1).trim();
    const label = LABELS.find(({ re }) => re.test(body));
    if (!label) continue;

    const matched = body.match(label.re)[0];
    const value = body.slice(matched.length).replace(/^[\s\u3000]+/, '').trim();
    if (!value) continue;

    if (label.field === 'imdb') {
      const m = value.match(/tt\d{5,}/);
      if (m) out.imdb = m[0];
    } else if (label.field === 'douban') {
      const m = value.match(/subject\/(\d+)/);
      if (m) out.douban = m[1];
    } else if (label.field === 'tmdb') {
      const m = value.match(/(?:movie|tv)\/(\d+)/);
      if (m) out.tmdb = m[1];
    } else if (label.field === 'year') {
      const m = value.match(/\d{4}/);
      if (m) out.year = Number(m[0]);
    } else if (label.field === 'runtime') {
      const m = value.match(/(\d+)\s*分钟/);
      if (m) out.runtimeMin = Number(m[1]);
    } else if (LIST_FIELDS.has(label.field)) {
      out[label.field] = splitList(value);
    } else {
      out[label.field] = value;
    }
  }

  return Object.keys(out).length ? out : null;
}
