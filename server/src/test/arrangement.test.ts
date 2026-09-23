import { describe, expect, test } from 'bun:test';
// meaning/arrangement.ts against the database: positions are written for
// every embedded image, the `meaning` sort puts the rest last, a new
// arrangement is a new build (queueing it: schedule.test.ts).
import { rankOrder } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';
import { arrangeBoard, arrangementOf } from '../meaning/arrangement.ts';
import { MODEL, toVectorText } from '../meaning/model.ts';

function unitVector(values: number[]): Float32Array {
  const out = new Float32Array(512);
  out.set(values);
  const norm = Math.hypot(...values) || 1;
  return out.map((v) => v / norm);
}

/** Images in slot order; `null` is an image with no embedding. */
async function boardWith(vectors: (number[] | null)[]) {
  const stamp = `${Date.now()}-${Math.random()}`;
  const { rows } = await pool.query(
    `INSERT INTO boards (org_id, name, open, created_by, image_count)
     VALUES ($1, $2, true, 'tester', $3) RETURNING id`,
    [`org-arrange-${stamp}`, `arrange-${stamp}`, vectors.length],
  );
  const boardId = rows[0].id as string;
  const ids: string[] = [];
  for (const [slot, values] of vectors.entries()) {
    const { rows: image } = await pool.query(
      `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, properties)
       VALUES ($1, $2, $3, $4, 10, 10, 'tester', '{}') RETURNING id`,
      [boardId, slot, `sha-${stamp}-${slot}`, `img-${slot}`],
    );
    ids.push(image[0].id);
    if (values) {
      await pool.query(
        `INSERT INTO image_embeddings (image_id, model, board_id, slot, embedding)
         VALUES ($1, $2, $3, $4, $5::halfvec)`,
        [image[0].id, MODEL, boardId, slot, toVectorText(unitVector(values))],
      );
    }
  }
  return { boardId, ids };
}

const meaning = { key: 'meaning', dir: 'asc' } as const;

describe('arrangement', () => {
  test('alike pictures sit together; one without an embedding goes last', async () => {
    // Slots alternate between two directions; slot 4 has no embedding.
    const { boardId } = await boardWith([
      [1, 0],
      [0, 1],
      [1, 0.1],
      [0.1, 1],
      null,
      [1, 0.05],
    ]);
    expect(await arrangementOf(boardId)).toEqual({ embedded: 5, placed: 0 });
    const { placed } = await arrangeBoard(boardId);
    expect(placed).toBe(5);
    expect(await arrangementOf(boardId)).toEqual({ embedded: 5, placed: 5 });
    const order = await rankOrder(boardId, meaning);
    const slots = Array.from(order.slotOfRank);
    expect(slots[5]).toBe(4);
    // The three [1, x] pictures are adjacent, as are the two [x, 1].
    const groupOf = (slot: number) => ([0, 2, 5].includes(slot) ? 'a' : 'b');
    const runs = slots.slice(0, 5).map(groupOf).join('');
    expect(['aaabb', 'bbaaa']).toContain(runs);

    // A late embedding is unplaced until the next arrangement places it.
    await pool.query(
      `INSERT INTO image_embeddings (image_id, model, board_id, slot, embedding)
       SELECT id, $2, board_id, slot, $3::halfvec FROM images
       WHERE board_id = $1 AND slot = 4`,
      [boardId, MODEL, toVectorText(unitVector([0, 1]))],
    );
    expect(await arrangementOf(boardId)).toEqual({ embedded: 6, placed: 5 });
    await arrangeBoard(boardId);
    expect(await arrangementOf(boardId)).toEqual({ embedded: 6, placed: 6 });
  });

  test('arranging again makes a new build of every sort', async () => {
    const { boardId } = await boardWith([
      [1, 0],
      [0, 1],
    ]);
    await arrangeBoard(boardId);
    const before = (await rankOrder(boardId, meaning)).version;
    await arrangeBoard(boardId);
    expect((await rankOrder(boardId, meaning)).version).not.toBe(before);
  });
});
