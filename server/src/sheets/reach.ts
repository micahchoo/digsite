// Where a sheet's images lead that the sheet does not show (CONTEXT.md
// "Reach"): other sheets' edges with exactly one end on this sheet, and the
// far images, enough to preview and bring them in. The overlay draws these;
// they never enter the scene (.claude/rules/foreign-never-in-scene.md).
import type {
  Reach,
  ReachEdge,
  ReachImage,
} from '@digsite/shared/sheet/claims';
import { pool } from '../db/pool.ts';
import { toEdgeRow } from './rows.ts';

/** Enough to show; keeps a heavily connected sheet's payload small. */
export const REACH_LIMIT = 500;

export async function reachOf(
  sheetId: string,
  boardId: string,
): Promise<Reach> {
  const { rows: edgeRows } = await pool.query(
    `WITH here AS (SELECT image_id FROM sheet_images WHERE sheet_id = $1)
     SELECT e.*, s.name AS sheet_name,
       e.src_image_id IN (SELECT image_id FROM here) AS src_near
     FROM edges e
     JOIN sheets s ON s.id = e.sheet_id
     WHERE e.sheet_id != $1 AND s.board_id = $2
       AND (e.src_image_id IN (SELECT image_id FROM here))
         <> (e.dst_image_id IN (SELECT image_id FROM here))
     ORDER BY e.id
     LIMIT ${REACH_LIMIT}`,
    [sheetId, boardId],
  );
  const edges: ReachEdge[] = edgeRows.map((e) => ({
    ...toEdgeRow(e),
    sheetName: e.sheet_name,
    near: e.src_near ? 'source' : 'target',
  }));
  const farIds = [
    ...new Set(
      edges.map((e) =>
        e.near === 'source' ? e.target.imageId : e.source.imageId,
      ),
    ),
  ];
  if (!farIds.length) return { edges, images: [] };
  const { rows } = await pool.query(
    'SELECT id, name, width, height, missing FROM images WHERE id = ANY($1::uuid[])',
    [farIds],
  );
  const images: ReachImage[] = rows.map((i) => ({
    id: i.id,
    name: i.name,
    width: i.width,
    height: i.height,
    missing: i.missing,
  }));
  return { edges, images };
}
