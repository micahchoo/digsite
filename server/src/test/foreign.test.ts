import { describe, expect, test } from 'bun:test';
// sheets/foreign.ts: which claims of other sheets a sheet holds, and how
// many other sheets hold a sheet's own claims. The two are one rule read
// in two directions, so each test puts a claim on ONE side only.
import { pool } from '../db/pool.ts';
import { foreignOn, sheetsShowing } from '../sheets/foreign.ts';

async function board() {
  const { rows } = await pool.query(
    `INSERT INTO boards (org_id, name, open, created_by)
     VALUES ($1, 'f', true, 'tester') RETURNING id`,
    [`org-foreign-${Date.now()}-${Math.random()}`],
  );
  return rows[0].id as string;
}

let slot = 0;
async function image(boardId: string) {
  slot += 1;
  const { rows } = await pool.query(
    `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by)
     VALUES ($1, $2, $3, 'i', 100, 100, 'tester') RETURNING id`,
    [boardId, slot, `sha-foreign-${slot}-${Math.random()}`],
  );
  return rows[0].id as string;
}

async function sheet(boardId: string, imageIds: string[]) {
  const { rows } = await pool.query(
    `INSERT INTO sheets (board_id, name, created_by)
     VALUES ($1, 's', 'tester') RETURNING id`,
    [boardId],
  );
  const id = rows[0].id as string;
  for (const img of imageIds) {
    await pool.query(
      'INSERT INTO sheet_images (sheet_id, image_id) VALUES ($1, $2)',
      [id, img],
    );
  }
  return id;
}

async function region(sheetId: string, imageId: string) {
  const id = `r-${Math.random()}`;
  await pool.query(
    `INSERT INTO regions (id, sheet_id, source_id, image_id, fx, fy, fw, fh)
     VALUES ($1, $2, $1, $3, 0, 0, 0.5, 0.5)`,
    [id, sheetId, imageId],
  );
  return id;
}

async function edge(sheetId: string, src: string, dst: string) {
  const id = `e-${Math.random()}`;
  await pool.query(
    `INSERT INTO edges (id, sheet_id, source_id, src_image_id, dst_image_id, direction)
     VALUES ($1, $2, $1, $3, $4, 'none')`,
    [id, sheetId, src, dst],
  );
  return id;
}

describe('foreign claims', () => {
  test("a sheet's region counts where another sheet holds its picture", async () => {
    const b = await board();
    const i = await image(b);
    const a = await sheet(b, [i]);
    const holder = await sheet(b, [i]);
    const r = await region(a, i);

    // A made the claim; the holder shows it. Not the other way round.
    expect(await sheetsShowing(a)).toBe(1);
    expect(await sheetsShowing(holder)).toBe(0);
    expect((await foreignOn(holder)).regions.map((x) => x.id)).toEqual([r]);
    expect((await foreignOn(a)).regions).toEqual([]);
  });

  test('an edge is held only by a sheet holding both its ends', async () => {
    const b = await board();
    const [i, j] = [await image(b), await image(b)];
    const a = await sheet(b, [i, j]);
    const both = await sheet(b, [i, j]);
    const one = await sheet(b, [i]);
    const e = await edge(a, i, j);

    expect(await sheetsShowing(a)).toBe(1);
    expect((await foreignOn(both)).edges.map((x) => x.id)).toEqual([e]);
    expect((await foreignOn(one)).edges).toEqual([]);
  });

  test('a sheet holding several of the claims counts once', async () => {
    const b = await board();
    const [i, j] = [await image(b), await image(b)];
    const a = await sheet(b, [i, j]);
    await sheet(b, [i, j]);
    await region(a, i);
    await region(a, j);
    await edge(a, i, j);
    expect(await sheetsShowing(a)).toBe(1);
  });
});
