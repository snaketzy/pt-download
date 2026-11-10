import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFeed } from '../src/sites/nexusphp.js';
import { normalizeTitle } from '../src/parsers/title.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const xml = fs.readFileSync(path.join(dir, '..', 'fixtures', 'nexusphp-sample.xml'), 'utf8');

const items = parseFeed(xml, { id: 1, name: 'fixture' });
console.log(`parsed ${items.length} item(s)\n`);

for (const item of items) {
  const parsed = normalizeTitle(item.title);
  console.log({
    title: item.title,
    freeType: item.freeType,
    sizeBytes: item.sizeBytes,
    infohash: item.infohash,
    downloadUrl: item.downloadUrl,
    resolution: parsed.resolution,
    source: parsed.source,
    codec: parsed.codec,
    hdr: parsed.hdr,
    group: parsed.group,
    markers: parsed.markers,
  });
}
