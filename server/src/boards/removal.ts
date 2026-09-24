// Removal: what removing an image, a sheet or a board takes with it — its
// rows, its stored objects and its group's quota. A route decides who may
// remove (access/) and answers; this module decides what goes.
//
// Before this module the three cascades were written inside their route
// handlers. The sheet's rows were spelled twice, and the board's removal
// never gave its bytes back to the group (storage/quota.ts), so a deleted
// board kept filling its group's quota for good.
//
// An image is never deleted as a row (CONTEXT.md "Missing"): it is marked
// missing and keeps its slot. Its original goes only when no other image
// still on the board stores the same bytes — storage keeps one object per
// board per sha256 — and the quota gets back exactly what was unlinked.
import type { PoolClient } from 'pg';
import type { ImageRow } from '../access/index.ts';
import { pool } from '../db/pool.ts';
import { deletePrefix, storageFromEnv } from '../storage/index.ts';
import { release, releaseFromGroup } from '../storage/quota.ts';
import { originalKey, sourceKey } from './paths.ts';

type ImageToRemove = Pick<
  ImageRow,
  | 'id'
  | 'board_id'
  | 'sha256'
  | 'missing'
  | 'bytes'
  | 'source_sha256'
  | 'source_bytes'
>;

/** Marks the image missing and unlinks what no other image on the board
 * still stores. Removing a missing image again changes nothing. */
export async function removeImage(image: ImageToRemove): Promise<void> {
  if (!image.missing) {
    const storage = storageFromEnv();
    if (!(await storedByAnother(image, 'sha256', image.sha256))) {
      // storage.delete is force-delete on both adapters (fs.ts, s3.ts).
      await storage.delete(originalKey(image.board_id, image.sha256));
      await release(image.board_id, Number(image.bytes ?? 0));
    }
    if (
      image.source_sha256 &&
      !(await storedByAnother(image, 'source_sha256', image.source_sha256))
    ) {
      await storage.delete(sourceKey(image.board_id, image.source_sha256));
      await release(image.board_id, Number(image.source_bytes ?? 0));
    }
  }
  await pool.query('UPDATE images SET missing = true WHERE id = $1', [
    image.id,
  ]);
}

async function storedByAnother(
  image: ImageToRemove,
  column: 'sha256' | 'source_sha256',
  sha: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM images
     WHERE board_id = $1 AND ${column} = $2 AND id != $3 AND missing = false
     LIMIT 1`,
    [image.board_id, sha, image.id],
  );
  return rows.length > 0;
}

/** The sheet's own rows. Claims other sheets saw as foreign vanish from
 * their next poll; their copies are their own and stay. */
export async function removeSheet(sheetId: string): Promise<void> {
  await inTransaction((client) => deleteSheetRows(client, 'id = $1', sheetId));
}

/** Every row that names the board, its group's bytes given back in the
 * same transaction, then a best-effort sweep of its files. The private
 * board's team is the caller's: removing it needs the request's session. */
export async function removeBoard(boardId: string): Promise<void> {
  await inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT b.org_id,
         (SELECT COALESCE(sum(o.bytes), 0) FROM (
            SELECT DISTINCT ON (sha256) bytes::bigint AS bytes
            FROM images WHERE board_id = $1 AND missing = false) o)
       + (SELECT COALESCE(sum(s.bytes), 0) FROM (
            SELECT DISTINCT ON (source_sha256) source_bytes::bigint AS bytes
            FROM images WHERE board_id = $1 AND missing = false
              AND source_sha256 IS NOT NULL) s) AS stored
       FROM boards b WHERE b.id = $1`,
      [boardId],
    );
    const board = rows[0];
    if (!board) return;

    // Children before the parents that reference them.
    await deleteSheetRows(client, 'board_id = $1', boardId);
    for (const table of [
      'board_rank_state',
      'term_aliases',
      'board_selections',
      'board_property_indexes',
      'activity',
      // Kept reports go with their board; a sheet's removal leaves them,
      // since they record what the sheet said (0031_reports.sql).
      'reports',
    ]) {
      await client.query(`DELETE FROM ${table} WHERE board_id = $1`, [boardId]);
    }
    await client.query(`DELETE FROM jobs WHERE payload->>'boardId' = $1`, [
      boardId,
    ]);
    await client.query('DELETE FROM images WHERE board_id = $1', [boardId]);
    await client.query('DELETE FROM boards WHERE id = $1', [boardId]);
    await releaseFromGroup(client, board.org_id, Number(board.stored));
  });

  // Every key for the board's originals, ladder pages and tiles lives
  // under this one prefix (paths.ts). Best-effort: the rows are gone
  // regardless, and a failure here never fails the removal.
  try {
    await deletePrefix(storageFromEnv(), `boards/${boardId}/`);
  } catch {
    // best-effort, see above.
  }
}

/** The rows under one or more sheets, then the sheets. `where` selects
 * sheets by `id` or by `board_id`, bound to $1. */
async function deleteSheetRows(
  client: PoolClient,
  where: 'id = $1' | 'board_id = $1',
  id: string,
): Promise<void> {
  for (const table of [
    'edges',
    'regions',
    'sheet_snapshots',
    'sheet_reads',
    'sheet_images',
  ]) {
    await client.query(
      `DELETE FROM ${table} WHERE sheet_id IN (SELECT id FROM sheets WHERE ${where})`,
      [id],
    );
  }
  await client.query(`DELETE FROM sheets WHERE ${where}`, [id]);
}

async function inTransaction(
  work: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await work(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
