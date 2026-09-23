// Sets every group's storage usage from what is stored (storage/quota.ts),
// once, for data stored before usage was counted: an image's size is read
// from its original where 0026 did not record it, then each group's total
// is recomputed with every stored object counted once. Safe to run again;
// run it with no uploads in flight, or a concurrent upload's bytes may be
// counted twice or not at all.
//
//   bun run scripts/backfill-storage.ts
import { originalKey } from '../src/boards/paths.ts';
import { pool } from '../src/db/pool.ts';
import { storageFromEnv } from '../src/storage/index.ts';

const storage = storageFromEnv();
const { rows: unsized } = await pool.query(
  `SELECT DISTINCT ON (board_id, sha256) board_id, sha256
   FROM images WHERE bytes IS NULL AND NOT missing`,
);
let sized = 0;
for (const { board_id, sha256 } of unsized) {
  const bytes = await storage.get(originalKey(board_id, sha256));
  if (!bytes) continue; // a synthetic image, or a purged original
  await pool.query(
    'UPDATE images SET bytes = $3 WHERE board_id = $1 AND sha256 = $2',
    [board_id, sha256, bytes.length],
  );
  sized++;
}
const { rows } = await pool.query(
  `WITH objects AS (
     SELECT DISTINCT ON (i.board_id, i.sha256) b.org_id, i.bytes AS n
     FROM images i JOIN boards b ON b.id = i.board_id
     WHERE NOT i.missing AND i.bytes IS NOT NULL
     UNION ALL
     SELECT DISTINCT ON (i.board_id, i.source_sha256) b.org_id, i.source_bytes
     FROM images i JOIN boards b ON b.id = i.board_id
     WHERE NOT i.missing AND i.source_sha256 IS NOT NULL
   )
   INSERT INTO group_storage (org_id, used_bytes)
   SELECT org_id, sum(n) FROM objects GROUP BY org_id
   ON CONFLICT (org_id) DO UPDATE SET used_bytes = EXCLUDED.used_bytes
   RETURNING org_id, used_bytes`,
);
console.log(`sized ${sized} originals; ${rows.length} groups counted`);
for (const r of rows) console.log(`  ${r.org_id}: ${r.used_bytes} bytes`);
await pool.end();
