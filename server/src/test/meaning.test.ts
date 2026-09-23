import { describe, expect, test } from 'bun:test';
// meaning/search.ts without a model: vectors written straight into
// image_embeddings, so the ranking, the exclusion and the mapping to ranks
// are tested without downloading CLIP. The model itself is exercised by the
// stage-4 measurement (scripts/measure-meaning.ts).
import type { Sort } from '@digsite/shared/board/sort';
import { buildOf } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';
import { MODEL, toVectorText } from '../meaning/model.ts';
import { nearest, similarTo } from '../meaning/search.ts';

/** A 512-dimension unit vector whose first components are `values`. */
function vector(values: number[]): Float32Array {
  const out = new Float32Array(512);
  out.set(values);
  const norm = Math.hypot(...values) || 1;
  return out.map((v) => v / norm);
}

async function boardWith(vectors: number[][]): Promise<{
  boardId: string;
  ids: string[];
}> {
  const { rows } = await pool.query(
    `INSERT INTO boards (org_id, name, open, created_by, image_count)
     VALUES ($1, $2, true, 'test-user', $3) RETURNING id`,
    [`org-meaning-${Date.now()}`, `meaning-${Date.now()}`, vectors.length],
  );
  const boardId = rows[0].id as string;
  const ids: string[] = [];
  for (const [slot, values] of vectors.entries()) {
    const { rows: image } = await pool.query(
      `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, properties)
       VALUES ($1, $2, $3, $4, 10, 10, 'tester', '{}') RETURNING id`,
      // Names in reverse, so name.asc is not slot order.
      [boardId, slot, `sha-${slot}`, `img-${9 - slot}`],
    );
    ids.push(image[0].id);
    await pool.query(
      `INSERT INTO image_embeddings (image_id, model, board_id, slot, embedding)
       VALUES ($1, $2, $3, $4, $5::halfvec)`,
      [image[0].id, MODEL, boardId, slot, toVectorText(vector(values))],
    );
  }
  return { boardId, ids };
}

const byName: Sort = { key: 'name', dir: 'asc' };

function pick(ids: string[], at: number[]): string[] {
  return ids
    .filter((_, i) => at.includes(i))
    .sort((a, b) => at.indexOf(ids.indexOf(a)) - at.indexOf(ids.indexOf(b)));
}

describe('meaning', () => {
  test('a small board among a large one still gets all its matches', async () => {
    // Search is scoped to one board: the large board's closer vectors must
    // never crowd out, or leak into, the small board's answer.
    await boardWith(Array.from({ length: 300 }, (_, i) => [1, i / 3000, 0]));
    const { boardId, ids } = await boardWith([
      [0, 1, 0],
      [0, 0.9, 0.1],
      [0.1, 0, 1],
    ]);
    const matches = await nearest(
      await buildOf(boardId, byName),
      vector([1, 0, 0]),
      3,
    );
    expect(matches.map((m) => m.imageId).sort()).toEqual([...ids].sort());
  });

  test('nearest keeps the best, best first, as ranks under the sort', async () => {
    const { boardId, ids } = await boardWith([
      [1, 0, 0],
      [0.9, 0.1, 0],
      [0, 1, 0],
      [0.7, 0.7, 0],
      [0, 0, 1],
    ]);
    const matches = await nearest(
      await buildOf(boardId, byName),
      vector([1, 0, 0]),
      3,
    );
    expect(matches.map((m) => m.imageId)).toEqual(pick(ids, [0, 1, 3]));
    // name.asc reverses slots: slot s is rank (4 - s) of five.
    expect(matches.map((m) => m.rank)).toEqual([4, 3, 1]);
    expect(matches[0]?.score).toBeGreaterThan(matches[2]?.score ?? 1);
  });

  test('similarTo leaves the image itself out, and answers null without an embedding', async () => {
    const { boardId, ids } = await boardWith([
      [1, 0],
      [0.8, 0.2],
      [0, 1],
    ]);
    const matches = await similarTo(
      await buildOf(boardId, byName),
      ids[0] as string,
      10,
    );
    expect(matches?.map((m) => m.imageId)).toEqual(pick(ids, [1, 2]));
    expect(
      await similarTo(await buildOf(boardId, byName), crypto.randomUUID(), 10),
    ).toBeNull();
  });
});
