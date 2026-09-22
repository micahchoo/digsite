import type { EdgeRow } from '@digsite/shared/sheet/claims';
import { SHEET_LIMIT } from '@digsite/shared/sheet/elements';
// Sheet-from-a-neighbourhood (docs/phases/2-sheet.md section 4): breadth-
// first over `edges`, in both directions — "an edge joins its two image
// ends regardless of region ends" (the task's own words; a region-bound
// edge still carries src_image_id/dst_image_id per 0002_domain.sql, so the
// walk never needs to look at regions at all). `edges` is the board's
// WHOLE graph, every sheet's claims unioned (CONTEXT.md "The union") — this
// deliberately walks across sheets, scoped to one board by joining `images`
// on both of an edge's ends.
import { pool } from '../db/pool.ts';
import { type EdgeDbRow, toEdgeRow } from './rows.ts';

export type NeighbourhoodImage = { id: string; hops: number };
export type Neighbourhood = {
  images: NeighbourhoodImage[];
  edges: EdgeRow[];
  truncated: boolean;
};

/**
 * Breadth-first from `from`, following `edges` up to `hops` steps, capped
 * at `limit` images nearest-first (`truncated: true` when more existed).
 * `limit` defaults to SHEET_LIMIT and is only ever overridden by tests —
 * the route never lets a caller raise it.
 */
export async function neighbourhoodFrom(
  boardId: string,
  from: string,
  hops: number,
  relation: string | undefined,
  limit: number = SHEET_LIMIT,
): Promise<Neighbourhood> {
  const { rows } = await pool.query(
    `WITH RECURSIVE nbhd(image_id, hops, path) AS (
       SELECT $1::uuid, 0, ARRAY[$1::uuid]
       UNION ALL
       SELECT step.next_id, n.hops + 1, n.path || step.next_id
       FROM nbhd n
       JOIN edges e ON e.src_image_id = n.image_id OR e.dst_image_id = n.image_id
       JOIN images si ON si.id = e.src_image_id AND si.board_id = $2
       JOIN images di ON di.id = e.dst_image_id AND di.board_id = $2
       CROSS JOIN LATERAL (
         SELECT CASE
           WHEN e.src_image_id = n.image_id THEN e.dst_image_id
           ELSE e.src_image_id
         END AS next_id
       ) step
       WHERE n.hops < $3
         AND ($4::text IS NULL OR e.relation = $4)
         AND step.next_id <> ALL(n.path)
     )
     SELECT image_id, MIN(hops) AS hops
     FROM nbhd
     GROUP BY image_id
     ORDER BY hops, image_id`,
    [from, boardId, hops, relation ?? null],
  );

  const truncated = rows.length > limit;
  const images: NeighbourhoodImage[] = rows
    .slice(0, limit)
    .map((r) => ({ id: r.image_id as string, hops: Number(r.hops) }));

  let edges: EdgeRow[] = [];
  if (images.length > 0) {
    const imageIds = images.map((i) => i.id);
    const { rows: edgeRows } = await pool.query(
      `SELECT * FROM edges
       WHERE src_image_id = ANY($1::uuid[]) AND dst_image_id = ANY($1::uuid[])
         AND ($2::text IS NULL OR relation = $2)`,
      [imageIds, relation ?? null],
    );
    edges = (edgeRows as EdgeDbRow[]).map(toEdgeRow);
  }

  return { images, edges, truncated };
}
