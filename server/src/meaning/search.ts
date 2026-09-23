// Nearest images to a query embedding, over one board, as ranks under the
// viewer's sort — the same shape as find (boards/find.ts), so the map can
// dim everything else the same way.
//
// pgvector's HNSW index answers it (0020_embeddings_pgvector.sql). The
// index spans every board; the iterative scan keeps reading until it has
// `limit` results from THIS board, so a small board among large ones is not
// starved. Iterative results come back roughly in order, and are sorted
// here by score.
import type { Sort } from '@digsite/shared/board/sort';
import { rankOf, rankOrder } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';
import { MODEL, toVectorText } from './model.ts';

export type Match = { imageId: string; rank: number; score: number };

/** `limit` best matches for `queryExpr`, a SQL expression producing a
 * halfvec, whose own parameters start at $5. */
async function nearestBy(
  boardId: string,
  sort: Sort,
  queryExpr: string,
  params: unknown[],
  limit: number,
  exclude: string | null,
): Promise<Match[]> {
  const client = await pool.connect();
  let rows: { image_id: string; slot: number; score: number }[];
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
    // ef_search bounds the candidates per step; below `limit` it would cap
    // the answer itself.
    await client.query(
      `SET LOCAL hnsw.ef_search = ${Math.max(40, Math.min(limit, 1000))}`,
    );
    const result = await client.query(
      `SELECT image_id, slot, 1 - (embedding <=> q) AS score
       FROM image_embeddings, (SELECT ${queryExpr} AS q) query
       WHERE board_id = $1 AND model = $2 AND image_id IS DISTINCT FROM $3
       ORDER BY embedding <=> q
       LIMIT $4`,
      [boardId, MODEL, exclude, limit, ...params],
    );
    rows = result.rows;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const order = await rankOrder(boardId, sort);
  return rows
    .map((row) => ({
      imageId: row.image_id,
      rank: rankOf(order, row.slot),
      score: Number(row.score),
    }))
    .filter((match) => match.rank >= 0)
    .sort((a, b) => b.score - a.score);
}

export function nearest(
  boardId: string,
  sort: Sort,
  query: Float32Array,
  limit: number,
): Promise<Match[]> {
  return nearestBy(
    boardId,
    sort,
    '$5::halfvec',
    [toVectorText(query)],
    limit,
    null,
  );
}

/** Images that look like this one, best first; the image itself left out.
 * Null when the image has no embedding (yet). */
export async function similarTo(
  boardId: string,
  imageId: string,
  sort: Sort,
  limit: number,
): Promise<Match[] | null> {
  const { rows } = await pool.query(
    'SELECT 1 FROM image_embeddings WHERE image_id = $1 AND model = $2',
    [imageId, MODEL],
  );
  if (rows.length === 0) return null;
  return nearestBy(
    boardId,
    sort,
    '(SELECT embedding FROM image_embeddings WHERE image_id = $5 AND model = $2)',
    [imageId],
    limit,
    imageId,
  );
}

/** Images that match words, best first. */
export async function searchText(
  boardId: string,
  text: string,
  sort: Sort,
  limit: number,
): Promise<Match[]> {
  const { embedText } = await import('./clip.ts');
  return nearest(boardId, sort, await embedText(text), limit);
}
