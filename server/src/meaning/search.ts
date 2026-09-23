// Nearest images to a query embedding, over one board, as ranks under the
// viewer's sort — the same shape as find (boards/find.ts), so the map can
// dim everything else the same way.
//
// Exact, not approximate (roadmap C5, 2026-09-23). The HNSW index found
// 0-13% of the true top 20 among a million random vectors, even at
// ef_search 1000; the exact scan found all of them in 145-162 ms (a
// parallel scan) and in under 1 ms on a small board, through the board
// index. `+ 0` keeps the planner off any vector index: the distance is an
// expression no index answers, so rows come from the board and are sorted.
import type { MeaningMatch } from '@digsite/shared/api';
import type { Sort } from '@digsite/shared/board/sort';
import { type RankOrder, rankOf, rankOrder } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';
import { MODEL, toVectorText } from './model.ts';

async function nearestText(
  boardId: string,
  sort: Sort,
  query: string,
  limit: number,
  exclude: string | null,
  given?: RankOrder,
): Promise<MeaningMatch[]> {
  const { rows } = await pool.query<{
    image_id: string;
    slot: number;
    score: number;
  }>(
    `SELECT image_id, slot, 1 - (embedding <=> $3::halfvec) AS score
     FROM image_embeddings
     WHERE board_id = $1 AND model = $2 AND image_id IS DISTINCT FROM $4
     ORDER BY (embedding <=> $3::halfvec) + 0
     LIMIT $5`,
    [boardId, MODEL, query, exclude, limit],
  );
  const order = given ?? (await rankOrder(boardId, sort));
  return rows
    .map((row) => ({
      imageId: row.image_id,
      rank: rankOf(order, row.slot),
      score: Number(row.score),
    }))
    .filter((match) => match.rank >= 0);
}

export function nearest(
  boardId: string,
  sort: Sort,
  query: Float32Array,
  limit: number,
  given?: RankOrder,
): Promise<MeaningMatch[]> {
  return nearestText(boardId, sort, toVectorText(query), limit, null, given);
}

/** Images that look like this one, best first; the image itself left out.
 * Null when the image has no embedding (yet). */
export async function similarTo(
  boardId: string,
  imageId: string,
  sort: Sort,
  limit: number,
  given?: RankOrder,
): Promise<MeaningMatch[] | null> {
  const { rows } = await pool.query(
    'SELECT embedding::text AS v FROM image_embeddings WHERE image_id = $1 AND model = $2',
    [imageId, MODEL],
  );
  const v = rows[0]?.v as string | undefined;
  if (!v) return null;
  return nearestText(boardId, sort, v, limit, imageId, given);
}

/** Images that match words, best first. */
export async function searchText(
  boardId: string,
  text: string,
  sort: Sort,
  limit: number,
  given?: RankOrder,
): Promise<MeaningMatch[]> {
  const { embedText } = await import('./clip.ts');
  return nearest(boardId, sort, await embedText(text), limit, given);
}
