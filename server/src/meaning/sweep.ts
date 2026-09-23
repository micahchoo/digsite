// The board-wide duplicate sweep (CONTEXT.md "Near-duplicate"): every
// group of near-duplicates on a board, for a "copies" view of a whole
// import. Asking duplicates.ts#duplicatesOf for every image would be one
// exact search each, 150 ms a picture at a million. The arrangement has
// already put pictures that close in meaning side by side (they share a
// leaf of its tree), so the sweep compares each picture only with the next
// WINDOW in `meaning` order, then asks the same two questions duplicatesOf
// asks: similarity >= MIN_SIMILARITY, pixels changed <= MAX_CHANGED.
//
// Runs as the worker's `duplicate-sweep` job after each arrangement, and
// replaces the board's pairs whole.
import { pool } from '../db/pool.ts';
import {
  MAX_CHANGED,
  MIN_SIMILARITY,
  cellGrey,
  changedFraction,
} from './duplicates.ts';
import { DIMS, boardVectors } from './embeddings.ts';

/** How far along the arrangement each picture looks for its copies. */
export const WINDOW = 32;

export type Swept = { pairs: number; checked: number; ms: number };

export async function sweepDuplicates(boardId: string): Promise<Swept> {
  const start = performance.now();
  const { ids, vectors } = await boardVectors(boardId);
  const row = new Map(ids.map((id, i) => [id, i]));
  const { rows: placed } = await pool.query<{ id: string; slot: number }>(
    `SELECT id, slot FROM images
     WHERE board_id = $1 AND meaning_pos IS NOT NULL AND NOT missing
     ORDER BY meaning_pos, slot`,
    [boardId],
  );
  const order = placed.filter((p) => row.has(p.id));
  const { data } = vectors;
  // Similarity on the packed scale: int8 vectors (x127) compare at 127².
  const scale = data instanceof Int8Array ? 127 * 127 : 1;
  const similarity = (i: number, j: number) => {
    let sum = 0;
    const a = i * DIMS;
    const b = j * DIMS;
    for (let k = 0; k < DIMS; k++) {
      sum += (data[a + k] as number) * (data[b + k] as number);
    }
    return sum / scale;
  };
  const grey = new Map<number, Uint8Array>();
  const greyOf = async (slot: number) => {
    let cell = grey.get(slot);
    if (!cell) {
      cell = await cellGrey(boardId, slot);
      grey.set(slot, cell);
    }
    return cell;
  };
  const pairs: { a: string; b: string; score: number }[] = [];
  let checked = 0;
  for (let p = 0; p < order.length; p++) {
    const here = order[p] as { id: string; slot: number };
    const i = row.get(here.id) as number;
    for (let q = p + 1; q < Math.min(order.length, p + 1 + WINDOW); q++) {
      const there = order[q] as { id: string; slot: number };
      const score = similarity(i, row.get(there.id) as number);
      if (score < MIN_SIMILARITY) continue;
      checked++;
      const changed = changedFraction(
        await greyOf(here.slot),
        await greyOf(there.slot),
      );
      if (changed <= MAX_CHANGED) {
        const [a, b] =
          here.id < there.id ? [here.id, there.id] : [there.id, here.id];
        pairs.push({ a, b, score });
      }
    }
    // Cells behind the window are not asked for again.
    if (p >= WINDOW) grey.delete((order[p - WINDOW] as { slot: number }).slot);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM duplicate_pairs WHERE board_id = $1', [
      boardId,
    ]);
    await client.query(
      `INSERT INTO duplicate_pairs (board_id, a, b, score)
       SELECT $1, a, b, s FROM unnest($2::uuid[], $3::uuid[], $4::real[]) AS u(a, b, s)
       ON CONFLICT DO NOTHING`,
      [
        boardId,
        pairs.map((x) => x.a),
        pairs.map((x) => x.b),
        pairs.map((x) => x.score),
      ],
    );
    await client.query(
      `INSERT INTO duplicate_sweeps (board_id, swept_at, pairs)
       VALUES ($1, now(), $2)
       ON CONFLICT (board_id) DO UPDATE SET swept_at = now(), pairs = $2`,
      [boardId, pairs.length],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { pairs: pairs.length, checked, ms: performance.now() - start };
}

/** The board's duplicate groups, each a list of image ids (pairs joined
 * through shared members), largest first; `complete` is false until the
 * board has been swept once. A missing image leaves its groups. */
export async function duplicateGroups(
  boardId: string,
): Promise<{ groups: string[][]; complete: boolean }> {
  const [{ rows: swept }, { rows }] = await Promise.all([
    pool.query('SELECT 1 FROM duplicate_sweeps WHERE board_id = $1', [boardId]),
    pool.query<{ a: string; b: string }>(
      `SELECT p.a, p.b FROM duplicate_pairs p
       JOIN images ia ON ia.id = p.a AND NOT ia.missing
       JOIN images ib ON ib.id = p.b AND NOT ib.missing
       WHERE p.board_id = $1`,
      [boardId],
    ),
  ]);
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    parent.set(x, root);
    return root;
  };
  for (const { a, b } of rows) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  }
  const byRoot = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    byRoot.set(root, [...(byRoot.get(root) ?? []), id]);
  }
  const groups = [...byRoot.values()]
    .map((g) => g.sort())
    .sort(
      (x, y) =>
        y.length - x.length || (x[0] as string).localeCompare(y[0] as string),
    );
  return { groups, complete: swept.length > 0 };
}
