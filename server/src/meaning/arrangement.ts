// A board's arrangement by meaning (CONTEXT.md "Arrangement"):
// images.meaning_pos, the place of each embedded image in the `meaning`
// sort, and images.meaning_group, the run of the map it belongs to. The
// sort reads those columns like any other key (ranks.ts#orderExpr), so
// rank builds, tiles, build tokens and materialise need nothing new; an
// image with no place yet sorts last.
//
// Two ways to place pictures, chosen by how much is new:
//   - full: the whole board through arrange.ts, positions 0..N-1, groups
//     named from the board's labels. 108 s at a million images.
//   - incremental: each new picture goes right after its nearest placed
//     neighbour, midway to the next position, in that neighbour's group.
//     One exact search per picture, 141 ms at a million images, so only
//     for a few at a time (200 at most, 28 s): before this, every small
//     upload to a big board re-arranged all of it.
// Either ends by saying the board changed: positions moved, so the tiles
// must be a new build (.claude/rules/tile-pixels-change-the-build.md).
import { boardChanged } from '../boards/change.ts';
import { pool } from '../db/pool.ts';
import { arrange } from './arrange.ts';
import { boardVectors } from './embeddings.ts';
import { type Embed, bestTerms } from './labels.ts';
import { MODEL } from './model.ts';

const WRITE_BATCH = 20_000;
/** New pictures are placed one by one only while they are at most this
 * many and at most INCREMENTAL_SHARE of those already placed; past
 * either, a full arrangement is cheaper and better. */
export const INCREMENTAL_MAX = 200;
const INCREMENTAL_SHARE = 0.1;
/** How deep the nearest search looks for a neighbour that has a place. */
const NEAREST_DEPTH = 8;

export type Arranged = {
  mode: 'full' | 'incremental' | 'none';
  placed: number;
  ms: number;
};

/** Brings the board's arrangement up to date: in full, one picture at a
 * time, or not at all when nothing is new. `embed` is for tests; the
 * worker names groups with CLIP's text model. */
export async function arrangeBoard(
  boardId: string,
  options: { embed?: Embed; full?: boolean } = {},
): Promise<Arranged> {
  const start = performance.now();
  const cleared = await clearUnembedded(boardId);
  const { embedded, placed } = await arrangementOf(boardId);
  const unplaced = embedded - placed;
  let mode: Arranged['mode'];
  let count = 0;
  if (
    !options.full &&
    placed > 0 &&
    unplaced <= Math.min(INCREMENTAL_MAX, placed * INCREMENTAL_SHARE)
  ) {
    mode = unplaced > 0 ? 'incremental' : 'none';
    count = unplaced > 0 ? await placeNew(boardId) : 0;
  } else {
    mode = 'full';
    count = await arrangeFully(boardId, options.embed);
  }
  if (mode !== 'none' || cleared > 0) await boardChanged(boardId);
  return { mode, placed: count, ms: performance.now() - start };
}

/** An image whose embedding went away keeps no stale place. An index
 * lookup per row: `id <> ALL($placed)` scanned the whole array per row. */
async function clearUnembedded(boardId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE images i SET meaning_pos = NULL, meaning_group = NULL
     WHERE i.board_id = $1 AND i.meaning_pos IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM image_embeddings e
                       WHERE e.image_id = i.id AND e.model = $2)`,
    [boardId, MODEL],
  );
  return rowCount ?? 0;
}

/** The whole board, placed again. Positions are written in batches, each
 * its own transaction: one over a million rows held every image's row
 * lock for 55 s. A rank build between two batches is still one whole
 * build under its own token, and the change at the end makes the next. */
async function arrangeFully(boardId: string, embed?: Embed): Promise<number> {
  const { ids, vectors } = await boardVectors(boardId);
  const { order, group } = arrange(vectors);
  const placed = Array.from(order, (row) => ids[row] as string);
  for (let from = 0; from < placed.length; from += WRITE_BATCH) {
    const n = Math.min(WRITE_BATCH, placed.length - from);
    await pool.query(
      `UPDATE images i SET meaning_pos = u.pos, meaning_group = u.grp
       FROM unnest($2::uuid[], $3::float8[], $4::int[]) AS u(id, pos, grp)
       WHERE i.id = u.id AND i.board_id = $1
         AND (i.meaning_pos IS DISTINCT FROM u.pos
              OR i.meaning_group IS DISTINCT FROM u.grp)`,
      [
        boardId,
        placed.slice(from, from + n),
        Array.from({ length: n }, (_, k) => from + k),
        Array.from(group.subarray(from, from + n)),
      ],
    );
  }
  await nameGroups(boardId, vectors, order, group, embed);
  return placed.length;
}

/** Each group's name: the board's label term nearest its centroid, with
 * a number when two groups share one; NULL ("Group n") on a board with
 * no labels. */
async function nameGroups(
  boardId: string,
  vectors: { data: ArrayLike<number>; dims: number },
  order: Int32Array,
  group: Int32Array,
  embed?: Embed,
): Promise<void> {
  const groups = group.length ? (group[group.length - 1] as number) + 1 : 0;
  const { dims, data } = vectors;
  const centroids = Array.from(
    { length: groups },
    () => new Float32Array(dims),
  );
  for (let p = 0; p < order.length; p++) {
    const c = centroids[group[p] as number] as Float32Array;
    const o = (order[p] as number) * dims;
    for (let k = 0; k < dims; k++) {
      c[k] = (c[k] as number) + (data[o + k] as number);
    }
  }
  const labels: (string | null)[] = [];
  const used = new Map<string, number>();
  for (const centroid of centroids) {
    const [best] = await bestTerms(boardId, centroid, 1, embed);
    if (!best) {
      labels.push(null);
      continue;
    }
    const seen = (used.get(best.term) ?? 0) + 1;
    used.set(best.term, seen);
    labels.push(seen === 1 ? best.term : `${best.term} ${seen}`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM meaning_groups WHERE board_id = $1', [
      boardId,
    ]);
    await client.query(
      `INSERT INTO meaning_groups (board_id, grp, label)
       SELECT $1, g - 1, label
       FROM unnest($2::text[]) WITH ORDINALITY AS u(label, g)`,
      [boardId, labels],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Places each embedded, unplaced picture right after its nearest placed
 * neighbour, midway to the next position, in that neighbour's group.
 * Pictures are placed one after another, so a later one can land next to
 * an earlier one. */
async function placeNew(boardId: string): Promise<number> {
  const { rows: fresh } = await pool.query<{ id: string }>(
    `SELECT i.id FROM images i
     JOIN image_embeddings e ON e.image_id = i.id AND e.model = $2
     WHERE i.board_id = $1 AND i.meaning_pos IS NULL
     ORDER BY i.slot LIMIT $3`,
    [boardId, MODEL, INCREMENTAL_MAX],
  );
  // Still to place; a picture placed earlier in this run counts as placed.
  const waiting = new Set(fresh.map((f) => f.id));
  for (const { id } of fresh) {
    // The exact search over the board's vectors alone, a few deep: joining
    // images to keep only placed ones made it 601 ms a picture at a
    // million images. The first of these that has a place is the one.
    const { rows: nearest } = await pool.query<{ image_id: string }>(
      `SELECT image_id FROM image_embeddings
       WHERE board_id = $1 AND model = $2 AND image_id <> $3
       ORDER BY (embedding <=> (SELECT embedding FROM image_embeddings
                                WHERE image_id = $3 AND model = $2)) + 0
       LIMIT $4`,
      [boardId, MODEL, id, NEAREST_DEPTH],
    );
    const candidates = nearest
      .map((n) => n.image_id)
      .filter((other) => !waiting.has(other));
    const { rows } = await pool.query<{
      id: string;
      pos: number;
      grp: number | null;
    }>(
      `SELECT id, meaning_pos AS pos, meaning_group AS grp FROM images
       WHERE id = ANY($1::uuid[]) AND meaning_pos IS NOT NULL`,
      [candidates],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const nearId = candidates.find((other) => byId.has(other));
    const near = nearId ? byId.get(nearId) : undefined;
    waiting.delete(id);
    if (!near) continue; // left for the next full arrangement
    const { rows: after } = await pool.query<{ next: number | null }>(
      `SELECT min(meaning_pos) AS next FROM images
       WHERE board_id = $1 AND meaning_pos > $2`,
      [boardId, near.pos],
    );
    const next = after[0]?.next;
    const pos =
      next === null || next === undefined
        ? near.pos + 1
        : (near.pos + next) / 2;
    await pool.query(
      'UPDATE images SET meaning_pos = $2, meaning_group = $3 WHERE id = $1',
      [id, pos, near.grp],
    );
  }
  return fresh.length;
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
