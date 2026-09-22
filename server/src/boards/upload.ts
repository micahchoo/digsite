// One upload (CONTEXT.md "Image", "Slot"): hash, decode, cap the longer
// side at 4096 (Figma's cap), write the original, assign the next slot and
// insert the row in one transaction that also marks every rank stale, then
// paint the ladder. See docs/design.md "Uploads and the ladder".
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { paintLadder } from './ladder.ts';
import { invalidateComposedTiles } from './tiles-cache.ts';

const MAX_SIDE = 4096;

export type UploadedImage = { id: string; slot: number };

function originalPath(boardId: string, sha256: string): string {
  return `${env.DATA_DIR}/boards/${boardId}/originals/${sha256}`;
}

export function originalPathFor(boardId: string, sha256: string): string {
  return originalPath(boardId, sha256);
}

export async function uploadOne(
  boardId: string,
  userId: string,
  filename: string,
  bytes: Uint8Array,
  properties: Record<string, unknown> = {},
): Promise<UploadedImage> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const decoded = await loadImage(Buffer.from(bytes));

  let width = decoded.width;
  let height = decoded.height;
  let stored: Buffer<ArrayBufferLike> = Buffer.from(bytes);
  let paintSource: typeof decoded = decoded;

  if (width > MAX_SIDE || height > MAX_SIDE) {
    const scale = MAX_SIDE / Math.max(width, height);
    const nw = Math.round(width * scale);
    const nh = Math.round(height * scale);
    const canvas = createCanvas(nw, nh);
    canvas.getContext('2d').drawImage(decoded, 0, 0, nw, nh);
    stored = canvas.encodeSync('png');
    width = nw;
    height = nh;
    paintSource = await loadImage(stored);
  }

  const path = originalPath(boardId, sha256);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, stored);
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
      `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, properties)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        boardId,
        slot,
        sha256,
        filename,
        width,
        height,
        userId,
        JSON.stringify(properties),
      ],
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
  await paintLadder(boardId, slot, paintSource, width, height);

  return { id: imageId, slot };
}
