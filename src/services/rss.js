import { fetchFeed, parseFeed } from '../sites/nexusphp.js';
import { normalizeTitle } from '../parsers/title.js';

// 轮询单个站点：取 RSS → 解析 → 标题归一化 → 批内按 guid 去重。
// 跨轮次去重由 DB 唯一键 (site_id, guid) 保证。
export async function pollSite(site) {
  const url = site.rssUrl ?? site.rss_url ?? null;
  const xml = await fetchFeed(url);
  const items = parseFeed(xml, site);

  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (seen.has(item.guid)) continue;
    seen.add(item.guid);
    out.push({ ...item, parsed: normalizeTitle(item.title) });
  }
  return out;
}
