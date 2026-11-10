import { pollSite } from './rss.js';
import { saveItems } from '../repositories/rssItems.js';
import { runRules } from '../engine/runner.js';

// 单站完整流程：抓取 RSS → 入库去重 → 立即评估规则并下发。
// 站点的下载链接带时间签名（分钟级失效），因此「入库」与「规则评估」必须在同一步完成，
// 手动触发（POST /api/sites/:id/poll）与定时轮询都走这里。
export async function pollAndDispatch(site, { dryRun = false } = {}) {
  const items = await pollSite(site);
  const saved = await saveItems(site.id, items);
  const engine = await runRules({ siteId: site.id, dryRun });
  return { parsed: items.length, ...saved, engine };
}
