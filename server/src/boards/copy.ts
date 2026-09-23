// Copy to another board (CONTEXT.md "Image intake"): pictures of one board
// become images of another, with their names, properties and kept camera
// sources, never their claims. Each goes through intake like any upload,
// as an original already (no conversion), so the target's quota and its
// duplicate check apply: a picture whose bytes are already on the target
// is skipped with where it is.
import { pool } from '../db/pool.ts';
import { storageFromEnv } from '../storage/index.ts';
import { type Examined, examine } from './intake.ts';
import { originalKey, sourceKey } from './paths.ts';

export const COPY_MAX = 500;

export type CopySkip = { id: string; reason: string };

/** Every picture to copy, examined against the target board; the route
 * then stores them with intake's `store`, whose failures are the
 * server's and are thrown (a full quota included), as for uploads. */
export async function examineCopies(
  fromBoardId: string,
  toBoardId: string,
  imageIds: string[],
): Promise<{ ready: Examined[]; skipped: CopySkip[] }> {
  const { rows } = await pool.query(
    `SELECT id, name, sha256, properties, missing, source_sha256, source_format
     FROM images WHERE board_id = $1 AND id = ANY($2::uuid[])`,
    [fromBoardId, imageIds],
  );
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  const storage = storageFromEnv();
  const ready: Examined[] = [];
  const skipped: CopySkip[] = [];
  for (const id of imageIds) {
    const row = byId.get(id);
    if (!row) {
      skipped.push({ id, reason: 'not on the source board' });
      continue;
    }
    if (row.missing) {
      skipped.push({ id, reason: 'deleted' });
      continue;
    }
    const bytes = await storage.get(originalKey(fromBoardId, row.sha256));
    if (!bytes) {
      skipped.push({ id, reason: 'its original is missing' });
      continue;
    }
    const kept =
      row.source_sha256 && row.source_format
        ? await storage.get(sourceKey(fromBoardId, row.source_sha256))
        : null;
    const examined = await examine(
      toBoardId,
      {
        name: row.name,
        bytes,
        properties: row.properties,
        asStored: kept
          ? { source: { bytes: kept, format: row.source_format } }
          : {},
      },
      { skipDuplicates: true },
    );
    if (examined.ok) ready.push(examined);
    else skipped.push({ id, reason: examined.reason });
  }
  return { ready, skipped };
}
