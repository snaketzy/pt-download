#!/usr/bin/env node
/**
 * 历届奥斯卡最佳影片（Academy Award for Best Picture）名单补齐。
 *
 * 数据源：Wikidata —— Q102427（最佳影片），P166（获奖）；仅取 IMDb Code 以 tt 开头的影片实体
 *        （P166 也会挂在制片人 nm 实体上，故必须过滤）。
 * 目标库：moive-database-op 的 MySQL（`movie_info_reference`，按 (raw_filename, imdb_id) 幂等 UPSERT）。
 *
 * 用法：
 *   node scripts/oscar-backfill.mjs           # dry-run：只对比、不写库（默认）
 *   node scripts/oscar-backfill.mjs --apply   # 实际写入
 *
 * 说明：
 *   - 与现有「奥斯卡 / 获奖」17 行同格式：raw_filename=【待收录】{英文名} ({年份})、award_list=奥斯卡、award_status=获奖。
 *   - 中文名优先取 Wikidata zh-hans（简体），回退 zh；再回退为空。
 *   - 不删任何旧数据，仅 INSERT / ON DUPLICATE KEY UPDATE 本脚本写入的字段。
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const WIKIDATA = 'https://query.wikidata.org/sparql';
const UA = 'pt-download/0.1 (oscar-backfill)';

const MDO = {
  host: process.env.MDO_DB_HOST,
  port: Number(process.env.MDO_DB_PORT || 3306),
  user: process.env.MDO_DB_USER,
  password: process.env.MDO_DB_PASSWORD,
  database: process.env.MDO_DB_NAME,
};

const QUERY = `
SELECT ?imdb (SAMPLE(?en) AS ?en) (SAMPLE(?zhh) AS ?zhh) (SAMPLE(?zh) AS ?zh) (MIN(?py) AS ?pubYear) WHERE {
  ?film wdt:P166 wd:Q102427 ; wdt:P345 ?imdb .
  FILTER(STRSTARTS(?imdb, "tt"))
  OPTIONAL { ?film rdfs:label ?en FILTER(lang(?en) = "en") }
  OPTIONAL { ?film rdfs:label ?zhh FILTER(lang(?zhh) = "zh-hans") }
  OPTIONAL { ?film rdfs:label ?zh FILTER(lang(?zh) = "zh") }
  OPTIONAL { ?film wdt:P577 ?pub . BIND(YEAR(?pub) AS ?py) }
}
GROUP BY ?imdb
ORDER BY ?pubYear`;

function val(binding) {
  return binding ? binding.value : null;
}

async function fetchWinners() {
  const url = `${WIKIDATA}?query=${encodeURIComponent(QUERY)}&format=json`;
  const res = await fetch(url, { headers: { Accept: 'application/sparql-results+json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  const json = await res.json();

  const seen = new Set();
  const out = [];
  for (const b of json.results.bindings) {
    const imdb = val(b.imdb);
    if (!imdb || seen.has(imdb)) continue;
    seen.add(imdb);

    const en = val(b.en);
    const zh = val(b.zhh) ?? val(b.zh);
    const year = val(b.pubYear) ? Number(val(b.pubYear)) : null;
    const name = (en || zh || imdb).trim();
    out.push({
      imdb,
      en,
      zh,
      year,
      // 独立前缀，避免与既有「【待收录】…」行同键（否则 UPSERT 会覆盖对方的 award_list）
      rawFilename: `【奥斯卡最佳影片】${name}${year ? ` (${year})` : ''}`,
    });
  }
  return out;
}

function dbDateTime(date = new Date()) {
  const t = date.toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 23)}`;
}

async function main() {
  if (!MDO.host || !MDO.user || !MDO.database) {
    throw new Error('缺少 MDO_DB_HOST / MDO_DB_USER / MDO_DB_PASSWORD / MDO_DB_NAME 环境变量');
  }

  console.log('拉取 Wikidata：历届最佳影片…');
  const winners = await fetchWinners();
  console.log(`Wikidata 返回 ${winners.length} 部最佳影片获奖片\n`);

  const conn = await mysql.createConnection({ ...MDO, charset: 'utf8mb4_general_ci' });
  try {
    const imdbs = winners.map((w) => w.imdb);
    const [existing] = await conn.query(
      'SELECT id, raw_filename, imdb_id, award_list, award_status, release_year, chinese_title ' +
        'FROM movie_info_reference WHERE imdb_id IN (?)',
      [imdbs],
    );
    const byKey = new Map();
    const byImdb = new Map();
    for (const row of existing) {
      byKey.set(`${row.raw_filename}\u0000${row.imdb_id}`, row);
      if (!byImdb.has(row.imdb_id)) byImdb.set(row.imdb_id, []);
      byImdb.get(row.imdb_id).push(row);
    }

    const inserts = [];
    const updates = [];
    const aliasHits = [];
    for (const w of winners) {
      const hit = byKey.get(`${w.rawFilename}\u0000${w.imdb}`);
      if (hit) {
        updates.push({ w, hit });
        continue;
      }
      inserts.push(w);
      const others = byImdb.get(w.imdb);
      if (others?.length) aliasHits.push({ w, others });
    }

    console.log(`将新增 ${inserts.length} 行，命中既有键（同 raw_filename+imdb）${updates.length} 行`);
    console.log(`同 IMDb 但文件名不同（不动既有，另建新行）${aliasHits.length} 部：`);
    for (const a of aliasHits.slice(0, 20)) {
      console.log(`  ${a.w.imdb} 新:${a.w.rawFilename}`);
      for (const o of a.others) console.log(`     已有: [${o.award_list ?? '-'}/${o.award_status ?? '-'}] ${o.raw_filename}`);
    }
    if (aliasHits.length > 20) console.log(`  …（其余 ${aliasHits.length - 20} 部略）`);

    const noZh = winners.filter((w) => !w.zh);
    if (noZh.length) console.log(`\n无中文名 ${noZh.length} 部：${noZh.map((w) => w.en || w.imdb).join('、')}`);

    console.log('\n新增预览：');
    for (const w of inserts.slice(0, 15)) console.log(`  + ${w.rawFilename}  ${w.imdb}  ${w.zh ?? ''}`);
    if (inserts.length > 15) console.log(`  …（其余 ${inserts.length - 15} 行略）`);

    if (!APPLY) {
      console.log('\n[dry-run] 未写库。加 --apply 实际执行。');
      return;
    }

    const now = dbDateTime();
    const rows = winners.map((w) => [w.rawFilename, w.imdb, '奥斯卡', '获奖', w.zh, w.year, now, now]);
    const [res] = await conn.query(
      `INSERT INTO movie_info_reference
         (raw_filename, imdb_id, award_list, award_status, chinese_title, release_year, created_at, updated_at)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         award_list = VALUES(award_list),
         award_status = VALUES(award_status),
         chinese_title = VALUES(chinese_title),
         release_year = VALUES(release_year),
         updated_at = VALUES(updated_at)`,
      [rows],
    );
    const [count] = await conn.query(
      'SELECT COUNT(*) AS c FROM movie_info_reference WHERE award_list = ? AND award_status = ?',
      ['奥斯卡', '获奖'],
    );
    console.log(`\n写入完成：affected=${res.affectedRows}；当前「奥斯卡 / 获奖」共 ${Number(count[0]?.c ?? 0)} 行`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(`执行失败: ${err.message}`);
  process.exitCode = 1;
});
