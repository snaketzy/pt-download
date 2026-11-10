import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFeed } from '../src/sites/nexusphp.js';
import { normalizeTitle } from '../src/parsers/title.js';
import { buildContext, evaluate } from '../src/engine/match.js';

// 用法: node scripts/test-match.js [rss.xml]
// 默认优先读 /tmp/mteam-sample.xml（M-Team 真实样本），否则回退到内置 fixture。
const dir = path.dirname(fileURLToPath(import.meta.url));
const candidates = [process.argv[2], '/tmp/mteam-sample.xml', path.join(dir, '..', 'fixtures', 'nexusphp-sample.xml')].filter(Boolean);
const xmlPath = candidates.find((p) => fs.existsSync(p));
if (!xmlPath) throw new Error('no RSS sample found');

const xml = fs.readFileSync(xmlPath, 'utf8');
const items = parseFeed(xml, { id: 1, name: 'sample' });
console.log(`feed: ${xmlPath}`);
console.log(`parsed ${items.length} item(s)\n`);

const itemsWithParsed = items.map((it) => ({ ...it, parsed: normalizeTitle(it.title) }));
const contexts = itemsWithParsed.map(buildContext);

// 演示规则集（覆盖 4K/1080p + 免费种 + 体积上限 + 中文语言/产地过滤）。
const RULES = [
  {
    name: '4K 免费种 ≤ 80GiB',
    match: {
      op: 'and',
      conditions: [
        { field: 'resolution', op: 'in', value: ['2160p', '2160P'] },
        { field: 'isFree', op: 'eq', value: true },
        { field: 'sizeGiB', op: 'lte', value: 80 },
      ],
    },
  },
  {
    name: '1080p Remux / 无 DV',
    match: {
      op: 'and',
      conditions: [
        { field: 'resolution', op: 'eq', value: '1080p' },
        { field: 'markers', op: 'nin', value: ['diy'] },
        { field: 'hdr', op: 'nin', value: ['DV'] },
      ],
    },
  },
  {
    name: '华语片（产地含中国）+ 有中文元数据',
    match: {
      op: 'and',
      conditions: [
        { field: 'regions', op: 'contains', value: '中国' },
        { field: 'titleCn', op: 'exists' },
      ],
    },
  },
  {
    name: '粤语原声',
    match: { field: 'languages', op: 'hasAny', value: ['粤语', '粵語'] },
  },
];

let totalMatched = 0;
for (const [i, ctx] of contexts.entries()) {
  console.log(`#${i + 1} ${ctx.title}`);
  console.log(
    `    res=${ctx.resolution} src=${ctx.source} codec=${ctx.codec} hdr=[${ctx.hdr}] free=${ctx.freeType} size=${ctx.sizeGiB}GiB`,
  );
  console.log(
    `    cn=${ctx.titleCn ?? '-'} regions=[${ctx.regions}] langs=[${ctx.languages}] genres=[${ctx.genres}]`
  );
  const hits = RULES.filter((r) => evaluate(r.match, ctx)).map((r) => r.name);
  totalMatched += hits.length;
  console.log(`    -> ${hits.length ? hits.join(' | ') : '(no match)'}\n`);
}

console.log(`rules=${RULES.length} contexts=${contexts.length} matches=${totalMatched}`);
