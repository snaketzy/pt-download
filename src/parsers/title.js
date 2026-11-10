import { createRequire } from 'node:module';

// parse-torrent-title 是 CJS 包，用 createRequire 保证 ESM 下稳定加载
const require = createRequire(import.meta.url);
const ptt = require('parse-torrent-title');

// 中文 PT 特有标记（PTT 不覆盖，需自补）
const MARKERS = [
  [/国语|国配|普通话|台配|公映国配|央视国配/, 'chineseAudio'],
  [/粤语|粵語|原声|港配/, 'cantoneseAudio'],
  [/特效字幕|特效中字/, 'specialSubtitle'],
  [/简繁|简英|繁英|中英双语|双语字幕/, 'subtitlesBoth'],
  [/简体|简中|CHS(?![A-Z])/, 'subtitlesCHS'],
  [/繁体|繁中|CHT(?![A-Z])/, 'subtitlesCHT'],
  [/中字|中文字幕|内嵌字幕|内封字幕|软字幕|硬字幕/, 'subtitles'],
  [/DIY|原盘DIY/, 'diy'],
  [/合集|全集|完结|Complete/i, 'complete'],
];

function extractHdr(raw) {
  const tags = [];
  if (/(?:^|[\s.\[])(?:DoVi|DV|Dolby ?Vision)(?:[\s.\]]|$)/i.test(raw)) tags.push('DV');
  if (/HDR10\+/i.test(raw)) tags.push('HDR10+');
  else if (/HDR10/i.test(raw)) tags.push('HDR10');
  else if (/(?:^|[\s.\[])(?:HDR)(?:[\s.\]]|$)/i.test(raw)) tags.push('HDR');
  if (/HLG/i.test(raw)) tags.push('HLG');
  return tags;
}

export function normalizeTitle(rawTitle = '') {
  const raw = String(rawTitle);
  let parsed = {};
  try {
    parsed = ptt.parse(raw) || {};
  } catch {
    parsed = {};
  }

  const markers = {};
  for (const [re, key] of MARKERS) {
    if (re.test(raw)) markers[key] = true;
  }

  return {
    raw,
    cleanTitle: parsed.title ?? null,
    year: parsed.year ?? null,
    resolution: parsed.resolution ?? null,
    source: parsed.source ?? null,
    codec: parsed.codec ?? null,
    audio: parsed.audio ?? null,
    group: parsed.group ?? null,
    season: parsed.season ?? null,
    episode: parsed.episode ?? null,
    hdr: extractHdr(raw),
    markers,
  };
}
