import { describe, expect, test } from 'bun:test';
// meaning/sweep.ts: the board-wide sweep finds, along the arrangement, the
// same near-duplicates duplicatesOf finds one picture at a time: close in
// meaning AND in pixels. Real ladder cells, painted from pictures drawn by
// sharp; vectors written straight in.
import sharp from 'sharp';
import { paintLadder } from '../boards/ladder.ts';
import { pool } from '../db/pool.ts';
import { arrangeBoard } from '../meaning/arrangement.ts';
import { MODEL, toVectorText } from '../meaning/model.ts';
import { duplicateGroups, sweepDuplicates } from '../meaning/sweep.ts';

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

function vector(values: number[]): Float32Array {
  const out = new Float32Array(512);
  out.set(values);
  const norm = Math.hypot(...values) || 1;
  return out.map((v) => v / norm);
}

describe('duplicate sweep', () => {
  test('a re-capture is grouped with its picture; another state and an unrelated picture are not', async () => {
    const stamp = `${Date.now()}-${Math.random()}`;
    const { rows } = await pool.query(
      `INSERT INTO boards (org_id, name, open, created_by, image_count)
       VALUES ($1, $2, true, 'tester', 4) RETURNING id`,
      [`org-sweep-${stamp}`, `sweep-${stamp}`],
    );
    const boardId = rows[0].id as string;
    const pictures = [
      { bytes: await screenshot(), v: [1, 0, 0] },
      {
        bytes: await screenshot(
          '<rect x="200" y="200" width="3" height="3" fill="#fff"/>',
        ),
        v: [1, 0.05, 0],
      },
      {
        bytes: await screenshot(
          '<rect x="150" y="150" width="90" height="60" fill="#bbb"/>',
        ),
        v: [1, 0.1, 0],
      },
      { bytes: await screenshot(), v: [0, 0, 1] },
    ];
    const ids: string[] = [];
    for (const [slot, { bytes, v }] of pictures.entries()) {
      const { rows: image } = await pool.query(
        `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, properties, status)
         VALUES ($1, $2, $3, $4, 256, 256, 'tester', '{}', 'ready') RETURNING id`,
        [boardId, slot, `sha-${stamp}-${slot}`, `s${slot}`],
      );
      ids.push(image[0].id);
      await pool.query(
        `INSERT INTO image_embeddings (image_id, model, board_id, slot, embedding)
         VALUES ($1, $2, $3, $4, $5::halfvec)`,
        [image[0].id, MODEL, boardId, slot, toVectorText(vector(v))],
      );
      await paintLadder(boardId, slot, bytes);
    }
    expect(await duplicateGroups(boardId)).toEqual({
      groups: [],
      complete: false,
    });
    await arrangeBoard(boardId);
    const swept = await sweepDuplicates(boardId);
    expect(swept.pairs).toBe(1);
    expect(await duplicateGroups(boardId)).toEqual({
      groups: [[ids[0] as string, ids[1] as string].sort()],
      complete: true,
    });
    // A deleted picture leaves its group.
    await pool.query('UPDATE images SET missing = true WHERE id = $1', [
      ids[1],
    ]);
    expect((await duplicateGroups(boardId)).groups).toEqual([]);
  });
});
