// Foreign claims (CONTEXT.md "Foreign"): what a sheet shows of other
// sheets' claims, and how many other sheets show its own. One rule, read
// in two directions: a sheet HOLDS a region when it holds the region's
// picture, and an edge when it holds both of its pictures.
//
// The rule was written out three times (the foreign poll, the delete
// footprint, reach), and the footprint's copy read it backwards: it
// counted other sheets' claims on this sheet, while the delete dialog
// says how many other sheets show THIS sheet's claims. Reach keeps its
// own query: its question is "exactly one end", not "held".
import type { ForeignEdge, ForeignRegion } from '@digsite/shared/sheet/claims';
import { pool } from '../db/pool.ts';
import { toEdgeRow, toRegionRow } from './rows.ts';

/** SQL: `holder` (a sheet id expression) holds the picture `image`. */
function holds(holder: string, image: string): string {
  return `${image} IN (SELECT image_id FROM sheet_images WHERE sheet_id = ${holder})`;
}
const holdsRegion = (holder: string, r: string) =>
  holds(holder, `${r}.image_id`);
const holdsEdge = (holder: string, e: string) =>
  `${holds(holder, `${e}.src_image_id`)} AND ${holds(holder, `${e}.dst_image_id`)}`;

/** Other sheets' claims this sheet holds: what its overlay draws. */
export async function foreignOn(
  sheetId: string,
): Promise<{ regions: ForeignRegion[]; edges: ForeignEdge[] }> {
  const { rows: regionRows } = await pool.query(
    `SELECT r.*, s.name AS sheet_name FROM regions r
     JOIN sheets s ON s.id = r.sheet_id
     WHERE r.sheet_id != $1 AND ${holdsRegion('$1', 'r')}`,
    [sheetId],
  );
  const { rows: edgeRows } = await pool.query(
    `SELECT e.*, s.name AS sheet_name FROM edges e
     JOIN sheets s ON s.id = e.sheet_id
     WHERE e.sheet_id != $1 AND ${holdsEdge('$1', 'e')}`,
    [sheetId],
  );
  return {
    regions: regionRows.map((r) => ({
      ...toRegionRow(r),
      sheetName: r.sheet_name,
    })),
    edges: edgeRows.map((e) => ({ ...toEdgeRow(e), sheetName: e.sheet_name })),
  };
}

/** How many other sheets hold at least one of this sheet's claims: what
 * deleting it takes off their overlays. */
export async function sheetsShowing(sheetId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS count FROM sheets h
     WHERE h.id != $1
       AND h.board_id = (SELECT board_id FROM sheets WHERE id = $1)
       AND (EXISTS (SELECT 1 FROM regions r
                    WHERE r.sheet_id = $1 AND ${holdsRegion('h.id', 'r')})
         OR EXISTS (SELECT 1 FROM edges e
                    WHERE e.sheet_id = $1 AND ${holdsEdge('h.id', 'e')}))`,
    [sheetId],
  );
  return Number(rows[0].count);
}
