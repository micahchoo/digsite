// A board's arrangement by meaning, as images.meaning_pos (roadmap item 6).
// The `meaning` sort reads that column like any other key
// (ranks.ts#orderExpr), so rank builds, tiles, build tokens and
// materialise need nothing new. An image with no position yet (not
// embedded, or embedded since the last arrangement) sorts last.
//
// The arrangement is recomputed whole, never patched, like an order: a
// new picture can change which group sits next to which. It runs as the
// worker's `arrange` job, 30 s after the last embed job of a burst, and
// ends by marking ranks stale. The positions changed, so the tiles must
// be a new build (.claude/rules/tile-pixels-change-the-build.md).
import { markBoardRanksStale } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';
import { arrange } from './arrange.ts';
import { MODEL } from './model.ts';

const PAGE = 20_000;
const WRITE_BATCH = 20_000;
const DIMS = 512;

// float16 bits -> float32, decoded once for every bit pattern.
const HALF = (() => {
  const table = new Float32Array(65536);
  const view = new DataView(new ArrayBuffer(2));
  for (let bits = 0; bits < 65536; bits++) {
    view.setUint16(0, bits);
    table[bits] = view.getFloat16(0);
  }
  return table;
})();

/** The board's embeddings, read in slot pages as pgvector's binary form:
 * a 16-bit dimension count, 16 unused bits, then big-endian float16s.
 * Written straight into one array sized by a count first; an image
 * embedded between the count and the last page waits for the next run. */
async function loadEmbeddings(
  boardId: string,
): Promise<{ ids: string[]; data: Float32Array }> {
  const { rows: counted } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM image_embeddings WHERE board_id = $1 AND model = $2',
    [boardId, MODEL],
  );
  const capacity = counted[0]?.n ?? 0;
  const data = new Float32Array(capacity * DIMS);
  const ids: string[] = [];
  let after = -1;
  while (ids.length < capacity) {
    const { rows } = await pool.query<{
      image_id: string;
      slot: number;
      bin: Buffer;
    }>(
      `SELECT image_id, slot, halfvec_send(embedding) AS bin
       FROM image_embeddings
       WHERE board_id = $1 AND model = $2 AND slot > $3
       ORDER BY slot LIMIT $4`,
      [boardId, MODEL, after, Math.min(PAGE, capacity - ids.length)],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const bin = row.bin;
      if (bin.readUInt16BE(0) !== DIMS) {
        throw new Error(`embedding of ${row.image_id} is not ${DIMS}-d`);
      }
      const o = ids.length * DIMS;
      for (let k = 0; k < DIMS; k++) {
        const at = 4 + k * 2;
        data[o + k] = HALF[
          ((bin[at] as number) << 8) | (bin[at + 1] as number)
        ] as number;
      }
      ids.push(row.image_id);
    }
    after = rows[rows.length - 1]?.slot as number;
    // Each page arrives as hex text and becomes Buffers, memory outside
    // the JS heap that the collector does not see coming. Measured at a
    // million images: 6.4 GB peak with no collection or a minor one per
    // page, 2.4 GB with a full one, and the load no slower (4.6 s).
    Bun.gc(true);
  }
  return { ids, data: data.subarray(0, ids.length * DIMS) };
}

/** Arranges one board and writes the positions; returns how many images
 * were placed. Only rows whose position changed are written, in batches
 * committed one by one: one transaction over a million rows held every
 * image's row lock for 55 s, and a property edit would have waited. A
 * rank build between two batches is still one consistent build under its
 * own token; the stale mark at the end makes the next one whole. */
export async function arrangeBoard(
  boardId: string,
): Promise<{ placed: number; ms: number }> {
  const start = performance.now();
  const { ids, data } = await loadEmbeddings(boardId);
  const order = arrange({ data, count: ids.length, dims: DIMS });
  const placed = Array.from(order, (row) => ids[row] as string);
  for (let from = 0; from < placed.length; from += WRITE_BATCH) {
    await pool.query(
      `UPDATE images i SET meaning_pos = u.pos
       FROM unnest($2::uuid[], $3::int[]) AS u(id, pos)
       WHERE i.id = u.id AND i.board_id = $1
         AND i.meaning_pos IS DISTINCT FROM u.pos`,
      [
        boardId,
        placed.slice(from, from + WRITE_BATCH),
        Array.from(
          { length: Math.min(WRITE_BATCH, placed.length - from) },
          (_, k) => from + k,
        ),
      ],
    );
  }
  // An image whose embedding went away keeps no stale place. An index
  // lookup per row: `id <> ALL($placed)` scanned the whole array per row.
  await pool.query(
    `UPDATE images i SET meaning_pos = NULL
     WHERE i.board_id = $1 AND i.meaning_pos IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM image_embeddings e
                       WHERE e.image_id = i.id AND e.model = $2)`,
    [boardId, MODEL],
  );
  await markBoardRanksStale(boardId);
  return { placed: placed.length, ms: performance.now() - start };
}

/** How far a board's arrangement is: images embedded, and images with a
 * position. Two index-only counts, not a join: at a million images the
 * join touched every row on every board load. `placed` never exceeds
 * `embedded`, because arrangeBoard clears the position of an image
 * whose embedding went away, so the difference is the unplaced count. */
export async function arrangementOf(
  boardId: string,
): Promise<{ embedded: number; placed: number }> {
  const [embedded, placed] = await Promise.all([
    pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM image_embeddings WHERE board_id = $1 AND model = $2',
      [boardId, MODEL],
    ),
    pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM images WHERE board_id = $1 AND meaning_pos IS NOT NULL',
      [boardId],
    ),
  ]);
  return { embedded: embedded.rows[0]?.n ?? 0, placed: placed.rows[0]?.n ?? 0 };
}

/** Queues an arrangement 30 s out, or moves a queued one out again: a
 * burst of embed jobs ends in one arrangement, not one each. */
export async function enqueueArrangeDebounced(boardId: string): Promise<void> {
  await pool.query(
    `INSERT INTO jobs (kind, payload, run_after)
     VALUES ('arrange', jsonb_build_object('boardId', $1::text), now() + interval '30 seconds')
     ON CONFLICT ((payload->>'boardId'))
       WHERE kind = 'arrange' AND state = 'pending'
       DO UPDATE SET run_after = now() + interval '30 seconds'`,
    [boardId],
  );
}

/** Makes sure an arrangement is queued, due now, without moving one
 * already queued. For the read path: GET /boards/:id called the debounced
 * enqueue, and a board polled every 3 s pushed its job out 30 s each time,
 * so a watched board was never arranged. */
export async function ensureArrangeQueued(boardId: string): Promise<void> {
  await pool.query(
    `INSERT INTO jobs (kind, payload)
     VALUES ('arrange', jsonb_build_object('boardId', $1::text))
     ON CONFLICT ((payload->>'boardId'))
       WHERE kind = 'arrange' AND state = 'pending'
       DO NOTHING`,
    [boardId],
  );
}
