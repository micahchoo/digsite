import { describe, expect, test } from 'bun:test';
// sheets/layout.ts and sheets/membership.ts: where the server places board
// pictures on a sheet, and which it adds, asked of the modules rather than
// of the routes.
import { SHEET_LIMIT } from '@digsite/shared/sheet/elements';
import { pool } from '../db/pool.ts';
import { CELL, FIT, appendOrigin, placePictures } from '../sheets/layout.ts';
import { addImages, createSheet } from '../sheets/membership.ts';

type Box = { x: number; y: number; width: number; height: number };
const box = (el: Record<string, unknown>) => el as unknown as Box;

describe('layout', () => {
  test('a square-ish grid of fitted pictures, each centred in its cell', () => {
    const els = placePictures([
      { id: 'a', width: 512, height: 256 },
      { id: 'b', width: 100, height: 100 },
      { id: 'c', width: 100, height: 100 },
    ]).map(box);
    // three pictures: two columns
    expect(els[0]).toMatchObject({ width: FIT, height: FIT / 2 });
    expect(els[0]?.x).toBe((CELL - FIT) / 2);
    expect(els[1]).toMatchObject({ x: CELL + 110, y: 110 });
    expect(els[2]).toMatchObject({ x: 110, y: CELL + 110 });
  });

  test('a centre the client sent wins for its picture', () => {
    const [el] = placePictures(
      [{ id: 'a', width: 100, height: 50 }],
      { x: 0, y: 0 },
      { a: { x: 1000, y: 500 } },
    ).map(box);
    expect(el).toMatchObject({ x: 950, y: 475, width: 100, height: 50 });
  });

  test('added pictures start a cell right of the pictures there, level with the top', () => {
    const stored = [
      { x: 0, y: 40, width: 200, height: 100, customData: { kind: 'image' } },
      { x: 300, y: 10, width: 100, height: 100, customData: { kind: 'image' } },
      { x: 5000, y: -900, width: 10, height: 10, customData: { kind: 'edge' } },
    ];
    expect(appendOrigin(stored)).toEqual({ x: 400 + CELL, y: 10 });
    expect(appendOrigin([])).toEqual({ x: 0, y: 0 });
  });
});

async function board(pictures: number) {
  const { rows } = await pool.query(
    `INSERT INTO boards (org_id, name, open, created_by)
     VALUES ($1, 'm', true, 'tester') RETURNING id`,
    [`org-membership-${Date.now()}-${Math.random()}`],
  );
  const boardId = rows[0].id as string;
  const { rows: imgs } = await pool.query(
    `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by)
     SELECT $1::uuid, g, md5($1::text || g), 'i' || g, 100, 100, 'tester'
     FROM generate_series(1, $2) g
     RETURNING id`,
    [boardId, pictures],
  );
  return { boardId, ids: imgs.map((r) => r.id as string) };
}

describe('membership', () => {
  test('a new sheet holds the pictures on its board, each once', async () => {
    const { boardId, ids } = await board(3);
    const other = await board(1);
    const made = await createSheet(
      boardId,
      's',
      [ids[0], ids[1], ids[0], other.ids[0]] as string[],
      'tester',
    );
    const { rows } = await pool.query(
      'SELECT image_id FROM sheet_images WHERE sheet_id = $1',
      [made?.id],
    );
    expect(rows.map((r) => r.image_id).sort()).toEqual(
      ([ids[0], ids[1]] as string[]).sort(),
    );
    expect(await createSheet(boardId, 's', other.ids, 'tester')).toBeNull();
  });

  test('past the limit a picture is skipped, and each is reported once', async () => {
    const { boardId, ids } = await board(SHEET_LIMIT + 3);
    const held = ids.slice(0, SHEET_LIMIT - 1);
    const made = await createSheet(boardId, 's', held, 'tester');
    const sheetId = made?.id as string;
    const [x, y, z] = ids.slice(SHEET_LIMIT - 1) as [string, string, string];

    const result = await addImages(sheetId, boardId, [
      x,
      y,
      x,
      ids[0] as string,
      z,
    ]);

    expect(result?.added).toEqual([x]);
    expect(result?.skipped).toEqual([ids[0] as string, y, z]);
    expect(result?.scene?.length).toBe(SHEET_LIMIT);
  });

  test('added pictures land to the right of the ones there', async () => {
    const { boardId, ids } = await board(2);
    const made = await createSheet(boardId, 's', [ids[0] as string], 'tester');
    const result = await addImages(made?.id as string, boardId, [
      ids[1] as string,
    ]);
    const scene = (result?.scene ?? []) as (Box & {
      customData: { imageId: string };
    })[];
    const first = scene.find((e) => e.customData.imageId === ids[0]);
    const added = scene.find((e) => e.customData.imageId === ids[1]);
    expect(added && first && added.x).toBeGreaterThan(
      (first?.x ?? 0) + (first?.width ?? 0) + CELL,
    );
  });
});
