import { describe, expect, test } from 'bun:test';
// meaning/arrangement.ts against the database: positions are written for
// every embedded image, the `meaning` sort puts the rest last, a new
// arrangement is a new build (queueing it: schedule.test.ts).
import { buildOf, rankOrder } from '../boards/ranks.ts';
import { sectionsFor } from '../boards/sections.ts';
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

  test('nothing new changes nothing; a forced full arrangement is a new build', async () => {
    const { boardId } = await boardWith([
      [1, 0],
      [0, 1],
    ]);
    expect((await arrangeBoard(boardId)).mode).toBe('full');
    const before = (await rankOrder(boardId, meaning)).version;
    expect((await arrangeBoard(boardId)).mode).toBe('none');
    expect((await rankOrder(boardId, meaning)).version).toBe(before);
    await arrangeBoard(boardId, { full: true });
    expect((await rankOrder(boardId, meaning)).version).not.toBe(before);
  });

  test('a few new pictures are placed beside their nearest, in its group', async () => {
    // Two groups of ten, far apart; then one picture like the first group.
    const a = Array.from({ length: 10 }, (_, i) => [1, i / 100, 0]);
    const b = Array.from({ length: 10 }, (_, i) => [0, i / 100, 1]);
    const { boardId } = await boardWith([...a, ...b]);
    expect((await arrangeBoard(boardId)).mode).toBe('full');
    const { rows: added } = await pool.query(
      `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, properties)
       VALUES ($1, 20, $2, 'late', 10, 10, 'tester', '{}') RETURNING id`,
      [boardId, `sha-late-${Date.now()}`],
    );
    await pool.query(
      `INSERT INTO image_embeddings (image_id, model, board_id, slot, embedding)
       VALUES ($1, $2, $3, 20, $4::halfvec)`,
      [added[0].id, MODEL, boardId, toVectorText(unitVector([1, 0.055, 0]))],
    );
    expect((await arrangeBoard(boardId)).mode).toBe('incremental');
    const { rows } = await pool.query(
      `SELECT slot, meaning_group FROM images WHERE board_id = $1
       ORDER BY meaning_pos NULLS LAST, slot`,
      [boardId],
    );
    const slots = rows.map((r) => r.slot as number);
    const at = slots.indexOf(20);
    // Both its neighbours on the map are from its own group (slots 0-9).
    const beside = [slots[at - 1], slots[at + 1]].filter(
      (x) => x !== undefined,
    ) as number[];
    expect(beside.every((slot) => slot < 10)).toBe(true);
    const groupOf = new Map(rows.map((r) => [r.slot, r.meaning_group]));
    expect(groupOf.get(20)).toBe(groupOf.get(0));
  });

  test("sections of the meaning sort are the groups, named by the board's own labels", async () => {
    const a = Array.from({ length: 40 }, (_, i) => [1, i / 400, 0]);
    const b = Array.from({ length: 40 }, (_, i) => [0, i / 400, 1]);
    const { boardId, ids } = await boardWith([...a, ...b]);
    // Two labels on the board, one per kind of picture.
    const { rows: sheet } = await pool.query(
      `INSERT INTO sheets (board_id, name, created_by) VALUES ($1, 'S', 'tester') RETURNING id`,
      [boardId],
    );
    for (const [i, label] of [
      [0, 'pottery'],
      [40, 'doorway'],
    ] as const) {
      await pool.query(
        `INSERT INTO regions (id, sheet_id, source_id, image_id, fx, fy, fw, fh, label)
         VALUES ($1, $2, $1, $3, 0, 0, 1, 1, $4)`,
        [`r-${boardId}-${i}`, sheet[0].id, ids[i], label],
      );
    }
    const embed = async (text: string) =>
      unitVector(text.endsWith('pottery') ? [1, 0, 0] : [0, 0, 1]);
    await arrangeBoard(boardId, { embed });
    const { sections } = await sectionsFor(await buildOf(boardId, meaning));
    const names = new Set(sections.map((s) => s.label.replace(/ \d+$/, '')));
    expect(names).toEqual(new Set(['pottery', 'doorway']));
    expect(sections[0]?.fromRank).toBe(0);
    expect(sections.at(-1)?.toRank).toBe(79);
  });
});
