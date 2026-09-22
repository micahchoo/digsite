// One upload (CONTEXT.md "Image", "Slot"): the request does the cheap,
// synchronous part only — sha256, store the raw original, assign the next
// slot and insert a `pending` row in one transaction that also marks every
// rank stale — then enqueues the `ladder` job. See docs/phases/1-map.md
// "Upload as a worker": decoding, the 4096-px cap, and painting the ladder
// all moved to worker/jobs.ts#runLadderJob. Both the multipart route
// (boards/routes.ts) and the tus `onUploadFinish` hook (boards/tus.ts) call
// this same function — it is the one ingest path either way.
//
// A pending row's width/height are 0 (images.width/height stay NOT NULL,
// unchanged by this phase) until the worker decodes the original and sets
// the real values alongside status = 'ready'.
import { createHash } from 'node:crypto';
import { pool } from '../db/pool.ts';
import { storageFromEnv } from '../storage/index.ts';
import { enqueueLadderJob } from '../worker/jobs.ts';
import { originalKey } from './paths.ts';
import { invalidateComposedTiles } from './tiles-cache.ts';

export type UploadedImage = { id: string; slot: number; status: 'pending' };

export async function uploadOne(
  boardId: string,
  userId: string,
  filename: string,
  bytes: Uint8Array,
  properties: Record<string, unknown> = {},
  contentType = 'application/octet-stream',
): Promise<UploadedImage> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const storage = storageFromEnv();
  const key = originalKey(boardId, sha256);
  // Content-addressed by sha256 within a board (docs/README's "Known
  // deviation" note is unrelated) — two uploads of the same bytes already
  // share one object, so a second upload never overwrites the first.
  if (!(await storage.exists(key))) {
    await storage.put(key, bytes, contentType);
  }

  const client = await pool.connect();
  let imageId: string;
  let slot: number;
  try {
    await client.query('BEGIN');
    const slotRes = await client.query(
      'UPDATE boards SET image_count = image_count + 1 WHERE id = $1 RETURNING image_count - 1 AS slot',
      [boardId],
    );
    slot = slotRes.rows[0].slot;
    const insRes = await client.query(
      `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, properties, status)
       VALUES ($1,$2,$3,$4,0,0,$5,$6,'pending') RETURNING id`,
      [boardId, slot, sha256, filename, userId, JSON.stringify(properties)],
    );
    imageId = insRes.rows[0].id;
    await client.query(
      'UPDATE board_rank_state SET stale = true WHERE board_id = $1',
      [boardId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  invalidateComposedTiles(boardId);
  await enqueueLadderJob(boardId, imageId);

  return { id: imageId, slot, status: 'pending' };
}
