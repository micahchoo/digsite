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
import { boardChanged } from '../boards/change.ts';
import { pool } from '../db/pool.ts';
import { arrange } from './arrange.ts';
import { boardVectors } from './embeddings.ts';
import { MODEL } from './model.ts';

const WRITE_BATCH = 20_000;

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
  const { ids, vectors } = await boardVectors(boardId);
  const order = arrange(vectors);
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
  await boardChanged(boardId);
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
