// The sheet's persisted scene (CONTEXT.md "Snapshot", "Projection"). Merged
// by element version (shared/sheet/merge.ts) so a stale client cannot roll a
// newer save back; projected (shared/sheet/project.ts) into rows so the
// board and other sheets learn a claim exists — the board itself never
// writes one.
import { mergeByVersion } from '@digsite/shared/sheet/merge';
import { type SceneElement, project } from '@digsite/shared/sheet/project';
import { pool } from '../db/pool.ts';

export async function getSnapshotElements(sheetId: string): Promise<unknown[]> {
  const { rows } = await pool.query(
    'SELECT elements FROM sheet_snapshots WHERE sheet_id = $1',
    [sheetId],
  );
  return rows.length ? rows[0].elements : [];
}

export type SaveResult = {
  elements: unknown[];
  unresolved: number;
  projectionMs: number;
};

/** Merges `incoming` onto the stored snapshot, saves it, and replaces this
 * sheet's region/edge rows from the merged scene — all in one transaction. */
export async function saveSnapshotAndProject(
  sheetId: string,
  incoming: unknown[],
): Promise<SaveResult> {
  const stored = (await getSnapshotElements(sheetId)) as SceneElement[];
  const merged = mergeByVersion(stored, incoming as SceneElement[]);

  const start = performance.now();
  let unresolved = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO sheet_snapshots (sheet_id, elements, saved_at)
       VALUES ($1, $2, now())
       ON CONFLICT (sheet_id) DO UPDATE SET elements = $2, saved_at = now()`,
      [sheetId, JSON.stringify(merged)],
    );

    const projected = project(sheetId, merged);
    const { regions, edges } = projected;
    unresolved = projected.unresolved;

    await client.query('DELETE FROM regions WHERE sheet_id = $1', [sheetId]);
    await client.query('DELETE FROM edges WHERE sheet_id = $1', [sheetId]);

    for (const r of regions) {
      await client.query(
        `INSERT INTO regions (id, sheet_id, source_id, image_id, fx, fy, fw, fh, label, properties)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          r.id,
          r.sheetId,
          r.sourceId,
          r.imageId,
          r.fx,
          r.fy,
          r.fw,
          r.fh,
          r.label,
          JSON.stringify(r.properties),
        ],
      );
    }
    for (const e of edges) {
      await client.query(
        `INSERT INTO edges (id, sheet_id, source_id, src_image_id, src_region_source_id, dst_image_id, dst_region_source_id, direction, relation, properties)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          e.id,
          e.sheetId,
          e.sourceId,
          e.source.imageId,
          e.source.regionSourceId ?? null,
          e.target.imageId,
          e.target.regionSourceId ?? null,
          e.direction,
          e.relation,
          JSON.stringify(e.properties),
        ],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const projectionMs = performance.now() - start;
  return { elements: merged, unresolved, projectionMs };
}
