import { describe, expect, test } from 'bun:test';
// meaning/duplicates.ts: a near-duplicate must be close in meaning AND in
// pixels. Vectors are written straight into image_embeddings (no CLIP
// download); the ladder is painted with real images drawn by sharp, so the
// pixel test reads the same 128-px cells an upload writes.
import type { Sort } from '@digsite/shared/board/sort';
import sharp from 'sharp';
import { paintLadder } from '../boards/ladder.ts';
import { buildOf } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';
import { changedFraction, duplicatesOf } from '../meaning/duplicates.ts';
import { MODEL, toVectorText } from '../meaning/model.ts';

/** A dark "screenshot" with lines of light text-like bars, plus `extra`. */
function screenshot(extra = ''): Promise<Buffer> {
  const lines = Array.from(
    { length: 8 },
    (_, i) =>
      `<rect x="20" y="${30 + i * 26}" width="${120 + ((i * 37) % 90)}" height="8" fill="#ddd"/>`,
  ).join('');
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#1e1e1e"/>${lines}${extra}</svg>`,
    ),
  )
    .png()
    .toBuffer();
}

/** A unit vector at `cos` similarity to the first axis. */
function vector(cos: number): Float32Array {
  const out = new Float32Array(512);
  out[0] = cos;
  out[1] = Math.sqrt(1 - cos * cos);
  return out;
}

async function boardWith(
  images: { bytes: Buffer; cos: number }[],
): Promise<{ boardId: string; ids: string[] }> {
  const { rows } = await pool.query(
    `INSERT INTO boards (org_id, name, open, created_by, image_count)
     VALUES ($1, $2, true, 'test-user', $3) RETURNING id`,
    [`org-dup-${Date.now()}`, `dup-${Date.now()}`, images.length],
  );
  const boardId = rows[0].id as string;
  const ids: string[] = [];
  for (const [slot, { bytes, cos }] of images.entries()) {
    const { rows: image } = await pool.query(
      `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, properties, status)
       VALUES ($1, $2, $3, $4, 256, 256, 'tester', '{}', 'ready') RETURNING id`,
      [boardId, slot, `sha-${slot}-${Date.now()}`, `img-${slot}`],
    );
    ids.push(image[0].id);
    await pool.query(
      `INSERT INTO image_embeddings (image_id, model, board_id, slot, embedding)
       VALUES ($1, $2, $3, $4, $5::halfvec)`,
      [image[0].id, MODEL, boardId, slot, toVectorText(vector(cos))],
    );
    await paintLadder(boardId, slot, bytes);
  }
  return { boardId, ids };
}

const byName: Sort = { key: 'name', dir: 'asc' };

describe('duplicates', () => {
  test('changedFraction counts pixels past the threshold, among picture pixels only', () => {
    const a = new Uint8Array([0, 100, 200, 50]);
    expect(changedFraction(a, new Uint8Array([10, 124, 176, 50]))).toBe(0);
    expect(changedFraction(a, new Uint8Array([30, 100, 200, 50]))).toBe(0.25);
    // Letterbox (0x22) in both cells is neither changed nor counted.
    const boxed = new Uint8Array([0x22, 0x22, 100, 200]);
    expect(changedFraction(boxed, new Uint8Array([0x22, 0x22, 100, 250]))).toBe(
      0.5,
    );
  });

  test('close in meaning and in pixels is a duplicate; close in meaning alone is not', async () => {
    const base = await screenshot();
    const { boardId, ids } = await boardWith([
      { bytes: base, cos: 1 },
      // A re-capture: one cursor-sized mark.
      {
        bytes: await screenshot(
          '<rect x="200" y="200" width="3" height="3" fill="#fff"/>',
        ),
        cos: 0.99,
      },
      // The same screen in another state: a panel opened.
      {
        bytes: await screenshot(
          '<rect x="150" y="150" width="90" height="60" fill="#bbb"/>',
        ),
        cos: 0.985,
      },
      // The same pixels, but meaning says otherwise: never reaches pixels.
      { bytes: base, cos: 0.9 },
    ]);
    const found = await duplicatesOf(
      await buildOf(boardId, byName),
      ids[0] as string,
    );
    expect(found?.map((m) => m.imageId)).toEqual([ids[1] as string]);
  });

  test('an image without an embedding answers null', async () => {
    const { boardId } = await boardWith([
      { bytes: await screenshot(), cos: 1 },
    ]);
    expect(
      await duplicatesOf(await buildOf(boardId, byName), crypto.randomUUID()),
    ).toBeNull();
  });
});
