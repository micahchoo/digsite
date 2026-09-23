import { describe, expect, test } from 'bun:test';
// meaning/embeddings.ts: one way to read stored vectors. A vector comes
// back as written, to float16 precision; a board's vectors pack as float32
// under the budget and int8 over it; an arrangement works on either.
import { buildOf } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { arrangeBoard } from '../meaning/arrangement.ts';
import { boardVectors, vectorOf } from '../meaning/embeddings.ts';
import { MODEL, toVectorText } from '../meaning/model.ts';

function unit(values: number[]): Float32Array {
  const out = new Float32Array(512);
  out.set(values);
  const norm = Math.hypot(...values) || 1;
  return out.map((v) => v / norm);
}

async function boardWith(vectors: number[][]) {
  const stamp = `${Date.now()}-${Math.random()}`;
  const { rows } = await pool.query(
    `INSERT INTO boards (org_id, name, open, created_by, image_count)
     VALUES ($1, $2, true, 'tester', $3) RETURNING id`,
    [`org-emb-${stamp}`, `emb-${stamp}`, vectors.length],
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
    await pool.query(
      `INSERT INTO image_embeddings (image_id, model, board_id, slot, embedding)
       VALUES ($1, $2, $3, $4, $5::halfvec)`,
      [image[0].id, MODEL, boardId, slot, toVectorText(unit(values))],
    );
  }
  return { boardId, ids };
}

describe('embedding store', () => {
  test('a vector comes back as written, to float16 precision', async () => {
    const { ids } = await boardWith([[0.6, 0.8]]);
    const got = await vectorOf(ids[0] as string);
    expect(got?.length).toBe(512);
    expect(got?.[0]).toBeCloseTo(0.6, 3);
    expect(got?.[1]).toBeCloseTo(0.8, 3);
    expect(await vectorOf(crypto.randomUUID())).toBeNull();
  });

  test('a board packs as float32 under the budget, int8 over it', async () => {
    const { boardId, ids } = await boardWith([
      [1, 0],
      [0, 1],
    ]);
    const roomy = await boardVectors(boardId);
    expect(roomy.vectors.data).toBeInstanceOf(Float32Array);
    expect(roomy.ids).toEqual(ids);
    const tight = await boardVectors(boardId, 1);
    expect(tight.vectors.data).toBeInstanceOf(Int8Array);
    expect([tight.vectors.data[0], tight.vectors.data[513]]).toEqual([
      127, 127,
    ]);
  });

  test('an arrangement over int8 vectors still groups alike pictures', async () => {
    const { boardId } = await boardWith([
      [1, 0],
      [0, 1],
      [1, 0.1],
      [0.1, 1],
    ]);
    const budget = env.ARRANGE_BUDGET_MB;
    env.ARRANGE_BUDGET_MB = 0;
    try {
      await arrangeBoard(boardId);
    } finally {
      env.ARRANGE_BUDGET_MB = budget;
    }
    const build = await buildOf(boardId, { key: 'meaning', dir: 'asc' });
    const group = (slot: number) => (slot % 2 === 0 ? 'a' : 'b');
    const runs = Array.from(build.order.slotOfRank, group).join('');
    expect(['aabb', 'bbaa']).toContain(runs);
  });
});
