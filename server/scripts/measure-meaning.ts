// Stage 4 measurement: CLIP embeddings through the product code
// (meaning/clip.ts, meaning/search.ts) on a real board's originals.
//
//   DATABASE_URL=... DATA_DIR=... EMBEDDINGS=on \
//     [MEASURE_INCLUDE=name,...] bun run scripts/measure-meaning.ts <boardId> [count] [text...]
//
// Embeds the first `count` ready images (writing image_embeddings, as the
// worker's embed job does), then times similarTo and searchText.
import type { Sort } from '@digsite/shared/board/sort';
import { originalKey } from '../src/boards/paths.ts';
import { pool } from '../src/db/pool.ts';
import { embedImage } from '../src/meaning/clip.ts';
import { MODEL, toVectorText } from '../src/meaning/model.ts';
import { searchText, similarTo } from '../src/meaning/search.ts';
import { storageFromEnv } from '../src/storage/index.ts';

const [boardId, countArg, ...queries] = Bun.argv.slice(2);
if (!boardId)
  throw new Error('usage: measure-meaning.ts <boardId> [count] [text...]');
const count = Number(countArg ?? 500);
const sort: Sort = { key: 'name', dir: 'asc' };
const rssMB = () => Math.round(process.memoryUsage().rss / 1048576);

// MEASURE_INCLUDE names images to embed besides the first `count` — a known
// odd one out makes a text query's answer checkable.
const include = (process.env.MEASURE_INCLUDE ?? '').split(',').filter(Boolean);
const { rows } = await pool.query(
  `(SELECT id, slot, sha256, name FROM images
    WHERE board_id = $1 AND status = 'ready' ORDER BY slot LIMIT $2)
   UNION
   (SELECT id, slot, sha256, name FROM images
    WHERE board_id = $1 AND status = 'ready' AND name = ANY($3::text[]))
   ORDER BY slot`,
  [boardId, count, include],
);
const storage = storageFromEnv();

let t = performance.now();
const first = await storage.get(originalKey(boardId, rows[0].sha256));
if (!first) throw new Error('first original missing');
await embedImage(first);
const loadMs = performance.now() - t;
const rssLoaded = rssMB();

t = performance.now();
for (const row of rows) {
  const bytes = await storage.get(originalKey(boardId, row.sha256));
  if (!bytes) continue;
  const vector = await embedImage(bytes);
  await pool.query(
    `INSERT INTO image_embeddings (image_id, model, board_id, slot, embedding)
     VALUES ($1, $2, $3, $4, $5::halfvec)
     ON CONFLICT (image_id, model) DO UPDATE SET embedding = EXCLUDED.embedding`,
    [row.id, MODEL, boardId, row.slot, toVectorText(vector)],
  );
}
const perImage = (performance.now() - t) / rows.length;

const anchor = rows[0];
t = performance.now();
const similar = (await similarTo(boardId, anchor.id, sort, 5)) ?? [];
const similarMs = performance.now() - t;
const names = new Map(rows.map((row) => [row.id, row.name]));

const texts: { query: string; ms: number; top: string[] }[] = [];
for (const query of queries.length
  ? queries
  : ['a white crystal', 'a red car']) {
  t = performance.now();
  const matches = await searchText(boardId, query, sort, 3);
  texts.push({
    query,
    ms: Math.round(performance.now() - t),
    top: matches.map((m) => `${names.get(m.imageId)} ${m.score.toFixed(3)}`),
  });
}

console.log(
  JSON.stringify(
    {
      images: rows.length,
      firstEmbedWithLoadMs: Math.round(loadMs),
      msPerImage: Number(perImage.toFixed(1)),
      rssAfterLoadMB: rssLoaded,
      rssEndMB: rssMB(),
      similarTo: {
        anchor: anchor.name,
        ms: Math.round(similarMs),
        top: similar.map(
          (m) => `${names.get(m.imageId)} ${m.score.toFixed(3)}`,
        ),
      },
      texts,
    },
    null,
    2,
  ),
);
await pool.end();
