import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { searchAwardWinners, downloadCandidate, listFacets } from '../services/discover.js';

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public/discover.html');

export default async function discoverRoutes(app) {
  // 搜索界面（深色单页，无外部依赖）
  app.get('/discover', async (_req, reply) => {
    try {
      const html = await readFile(PAGE, 'utf8');
      return reply.type('text/html; charset=utf-8').send(html);
    } catch (err) {
      return reply.code(500).send(`读取页面失败: ${err.message}`);
    }
  });

  // 片单维度取值：奖项 / 结果（含计数），供搜索界面下拉使用。
  app.get('/api/discover/facets', async (_req, reply) => {
    try {
      return await listFacets();
    } catch (err) {
      return reply.code(502).send({ ok: false, error: err.message });
    }
  });

  // 搜索 + 预览：读 mdo 片单 → M-Team 按 IMDb 反查 → 聚合返回。只读，不下发。
  // body: { award, status, limit, offset, perTitle, maxPages, minSeeders, concurrency, minIntervalMs }
  app.post('/api/discover/search', async (req, reply) => {
    const { award, status, limit, offset, perTitle, maxPages, minSeeders, concurrency, minIntervalMs } =
      req.body ?? {};
    try {
      return await searchAwardWinners({
        award,
        status,
        limit,
        offset,
        perTitle,
        maxPages,
        minSeeders,
        concurrency,
        minIntervalMs,
      });
    } catch (err) {
      return reply.code(502).send({ ok: false, error: err.message });
    }
  });

  // 点击下载：把单个候选种子下发给 qBittorrent（M-Team 签名直链 → qB → downloads 落库）。
  // body: { torrentId, title, sizeBytes, freeType, savePath, category, tags }
  app.post('/api/discover/download', async (req, reply) => {
    const { torrentId, title, sizeBytes, freeType, savePath, category, tags } = req.body ?? {};
    try {
      return await downloadCandidate({ torrentId, title, sizeBytes, freeType, savePath, category, tags });
    } catch (err) {
      return reply.code(502).send({ ok: false, error: err.message });
    }
  });
}
