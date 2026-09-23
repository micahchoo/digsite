import { mergeByVersion } from '@digsite/shared/sheet/merge';
import { type SceneElement, project } from '@digsite/shared/sheet/project';
// The sheet's persisted scene (CONTEXT.md "Snapshot", "Projection"). Merged
// by element version (shared/sheet/merge.ts) so a stale client cannot roll a
// newer save back; projected into rows so the board and other sheets learn
// a claim exists — the sheet remains the one writer of its claims.
import type { PoolClient } from 'pg';
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

/** The caller owns the transaction and holds the sheet row lock. */
export async function saveSnapshotAndProjectInTransaction(
  client: PoolClient,
  sheetId: string,
  incoming: unknown[],
): Promise<SaveResult> {
  const sheet = await client.query(
    'SELECT id FROM sheets WHERE id = $1 FOR UPDATE',
    [sheetId],
  );
  if (sheet.rows.length === 0) throw new Error('sheet not found');
  const { rows: saved } = await client.query(
    'SELECT elements FROM sheet_snapshots WHERE sheet_id = $1',
    [sheetId],
  );
  const stored = (saved.length ? saved[0].elements : []) as SceneElement[];
  const merged = mergeByVersion(stored, incoming as SceneElement[]);

  const start = performance.now();
  const projected = project(sheetId, merged);
  await client.query(
    `INSERT INTO sheet_snapshots (sheet_id, elements, saved_at)
     VALUES ($1, $2, now())
     ON CONFLICT (sheet_id) DO UPDATE SET elements = $2, saved_at = now()`,
    [sheetId, JSON.stringify(merged)],
  );
  await client.query('DELETE FROM regions WHERE sheet_id = $1', [sheetId]);
  await client.query('DELETE FROM edges WHERE sheet_id = $1', [sheetId]);

  for (const r of projected.regions) {
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
  for (const e of projected.edges) {
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

  return {
    elements: merged,
    unresolved: projected.unresolved,
    projectionMs: performance.now() - start,
  };
}

/** Merges and projects one scene in a transaction. Every writer takes the
 * sheet row lock before reading the saved scene, so concurrent room saves
 * cannot overwrite one another from the same stale snapshot. */
export async function saveSnapshotAndProject(
  sheetId: string,
  incoming: unknown[],
): Promise<SaveResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await saveSnapshotAndProjectInTransaction(
      client,
      sheetId,
      incoming,
    );
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
