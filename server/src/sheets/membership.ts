// Which board pictures a sheet holds: making a sheet from some, and adding
// more later. A route decides who may (access/) and answers; this module
// decides what lands where, inside one transaction.
//
// Both hold to SHEET_LIMIT the same way: pictures past it are skipped, not
// refused (docs/ux/design.md §5.1 "no action is ever refused outright").
// Both write the scene through snapshot.ts's merge, the one path every
// snapshot writer takes.
import { SHEET_LIMIT } from '@digsite/shared/sheet/elements';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.ts';
import { type Picture, appendOrigin, placePictures } from './layout.ts';
import { saveSnapshotAndProjectInTransaction } from './snapshot.ts';
import { signStored } from './stamps.ts';

/** The board's pictures among `ids`, in the order asked; the rest are not
 * on the board. */
async function picturesOnBoard(
  db: PoolClient,
  boardId: string,
  ids: readonly string[],
): Promise<{ found: Picture[]; notOnBoard: string[] }> {
  if (ids.length === 0) return { found: [], notOnBoard: [] };
  const { rows } = await db.query(
    'SELECT id, width, height FROM images WHERE board_id = $1 AND id = ANY($2::uuid[])',
    [boardId, ids],
  );
  const byId = new Map(rows.map((r) => [r.id as string, r as Picture]));
  return {
    found: ids.flatMap((id) => byId.get(id) ?? []),
    notOnBoard: ids.filter((id) => !byId.has(id)),
  };
}

async function inTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A new sheet holding the first SHEET_LIMIT of `imageIds` that are on the
 * board, placed in a grid unless `centres` names a picture's centre. Null
 * when none of them is on the board.
 */
export async function createSheet(
  boardId: string,
  name: string,
  imageIds: readonly string[],
  createdBy: string,
  centres: Readonly<Record<string, { x: number; y: number }>> = {},
): Promise<{ id: string } | null> {
  return inTransaction(async (client) => {
    const { found } = await picturesOnBoard(
      client,
      boardId,
      [...new Set(imageIds)].slice(0, SHEET_LIMIT),
    );
    if (found.length === 0) return null;
    const { rows } = await client.query(
      'INSERT INTO sheets (board_id, name, created_by) VALUES ($1,$2,$3) RETURNING id',
      [boardId, name, createdBy],
    );
    const id = rows[0].id as string;
    for (const p of found) {
      await client.query(
        'INSERT INTO sheet_images (sheet_id, image_id) VALUES ($1,$2)',
        [id, p.id],
      );
    }
    await saveSnapshotAndProjectInTransaction(
      client,
      id,
      placePictures(found, { x: 0, y: 0 }, centres),
    );
    return { id };
  });
}

export type Added = {
  added: string[];
  /** Already on the sheet, not on the board, or past the limit; each id
   * once, however often it was asked for. */
  skipped: string[];
  /** The whole scene after the addition, stamps signed as stored: what
   * the room is told. Null when nothing was added. */
  scene: unknown[] | null;
};

/** Adds board pictures to a sheet, to the right of what it holds. Null
 * when the sheet is gone. */
export async function addImages(
  sheetId: string,
  boardId: string,
  imageIds: readonly string[],
): Promise<Added | null> {
  return inTransaction(async (client) => {
    const locked = await client.query(
      'SELECT id FROM sheets WHERE id = $1 FOR UPDATE',
      [sheetId],
    );
    if (locked.rows.length === 0) return null;
    const { rows: held } = await client.query(
      'SELECT image_id FROM sheet_images WHERE sheet_id = $1',
      [sheetId],
    );
    const already = new Set(held.map((r) => r.image_id as string));

    const asked = [...new Set(imageIds)];
    const skipped = asked.filter((id) => already.has(id));
    const { found, notOnBoard } = await picturesOnBoard(
      client,
      boardId,
      asked.filter((id) => !already.has(id)),
    );
    skipped.push(...notOnBoard);
    const room = Math.max(0, SHEET_LIMIT - already.size);
    const toAdd = found.slice(0, room);
    skipped.push(...found.slice(room).map((p) => p.id));
    if (toAdd.length === 0) return { added: [], skipped, scene: null };

    // Placed against the CURRENT snapshot, read inside the lock: act on
    // stored state rebased at write time, never a cache.
    const { rows: snapshot } = await client.query(
      'SELECT elements FROM sheet_snapshots WHERE sheet_id = $1',
      [sheetId],
    );
    const stored = (snapshot[0]?.elements ?? []) as unknown[];
    for (const p of toAdd) {
      await client.query(
        'INSERT INTO sheet_images (sheet_id, image_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [sheetId, p.id],
      );
    }
    const saved = await saveSnapshotAndProjectInTransaction(
      client,
      sheetId,
      placePictures(toAdd, appendOrigin(stored)),
    );
    return {
      added: toAdd.map((p) => p.id),
      skipped,
      scene: signStored(saved.elements, sheetId),
    };
  });
}
