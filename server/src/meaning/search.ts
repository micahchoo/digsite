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
import { type Build, rankOf } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';
import { vectorOf } from './embeddings.ts';
import { MODEL, toVectorText } from './model.ts';

async function nearestText(
  { boardId, order }: Build,
  query: string,
  limit: number,
  exclude: string | null,
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
  return rows
    .map((row) => ({
      imageId: row.image_id,
      rank: rankOf(order, row.slot),
      score: Number(row.score),
    }))
    .filter((match) => match.rank >= 0);
}

export function nearest(
  build: Build,
  query: Float32Array,
  limit: number,
): Promise<MeaningMatch[]> {
  return nearestText(build, toVectorText(query), limit, null);
}

/** Images that look like this one, best first; the image itself left out.
 * Null when the image has no embedding (yet). */
export async function similarTo(
  build: Build,
  imageId: string,
  limit: number,
): Promise<MeaningMatch[] | null> {
  const vector = await vectorOf(imageId);
  if (!vector) return null;
  return nearestText(build, toVectorText(vector), limit, imageId);
}

/** Images that match words, best first. */
export async function searchText(
  build: Build,
  text: string,
  limit: number,
): Promise<MeaningMatch[]> {
  const { embedText } = await import('./clip.ts');
  return nearest(build, await embedText(text), limit);
}
