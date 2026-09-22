// docs/phases/2-sheet.md section 4: a 12-image chain, two relations. hops
// 1..3 return the right sets; the relation filter narrows the walk; the cap
// truncates nearest-first. Fixture inserted directly via SQL (same style as
// snapshot.test.ts) — no HTTP, no sheets, since neighbourhoodFrom reads
// `images`/`edges` only.
import { describe, expect, test } from 'bun:test';
import { pool } from '../db/pool.ts';
import { neighbourhoodFrom } from '../sheets/neighbourhood.ts';

async function makeBoard(name: string): Promise<string> {
  const { rows } = await pool.query(
    'INSERT INTO boards (org_id, name, open, created_by) VALUES ($1,$2,true,$3) RETURNING id',
    [`org-nbhd-${Date.now()}`, name, 'test-user'],
  );
  return rows[0].id;
}

async function makeImage(boardId: string, slot: number): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by)
     VALUES ($1,$2,$3,$4,200,200,'tester') RETURNING id`,
    [
      boardId,
      slot,
      `sha-nbhd-${slot}-${Date.now()}-${Math.random()}`,
      `img-${slot}`,
    ],
  );
  return rows[0].id;
}

// A fake sheet/source id is fine — neighbourhoodFrom never joins sheets or
// regions, only edges' own image columns (CONTEXT.md "an edge joins its two
// image ends regardless of region ends"). The id must be unique across runs
// against the same (unmigrated-between-runs) database, not just within one
// process, so it carries time + randomness like the other fixtures here.
let seq = 0;
async function makeEdge(
  sheetId: string,
  srcImageId: string,
  dstImageId: string,
  relation: string,
): Promise<void> {
  seq++;
  const uid = `${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    `INSERT INTO edges (id, sheet_id, source_id, src_image_id, dst_image_id, direction, relation)
     VALUES ($1,$2,$3,$4,$5,'forward',$6)`,
    [
      `nbhd-edge-${uid}`,
      sheetId,
      `src-${uid}`,
      srcImageId,
      dstImageId,
      relation,
    ],
  );
}

/** A required array element — `noUncheckedIndexedAccess` makes `arr[i]`
 * `T | undefined`; the fixtures above never actually produce a gap, so a
 * throw here means the fixture itself is broken, not the code under test. */
function at<T>(arr: T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`fixture: no element at index ${i}`);
  return v;
}

/** A 12-image chain img0 - img1 - ... - img11, alternating relation
 * 'resembles' (even hop) / 'contradicts' (odd hop) so a relation filter cuts
 * the chain in half. */
async function makeChain(): Promise<{
  boardId: string;
  sheetId: string;
  images: string[];
}> {
  const boardId = await makeBoard(`nbhd-chain-${Date.now()}`);
  const { rows: sheetRows } = await pool.query(
    `INSERT INTO sheets (board_id, name, created_by) VALUES ($1,'S',$2) RETURNING id`,
    [boardId, 'tester'],
  );
  const sheetId = sheetRows[0].id;

  const images: string[] = [];
  for (let i = 0; i < 12; i++) images.push(await makeImage(boardId, i));

  for (let i = 0; i < 11; i++) {
    const relation = i % 2 === 0 ? 'resembles' : 'contradicts';
    const img0 = images[i];
    const img1 = images[i + 1];
    if (img0 === undefined || img1 === undefined) throw new Error('bad chain');
    await makeEdge(sheetId, img0, img1, relation);
  }

  return { boardId, sheetId, images };
}

describe('neighbourhoodFrom', () => {
  test('hops 1..3 return the right sets on a 12-image chain', async () => {
    const { boardId, images } = await makeChain();
    const i0 = at(images, 0);
    const i1 = at(images, 1);
    const i2 = at(images, 2);
    const i3 = at(images, 3);

    const h1 = await neighbourhoodFrom(boardId, i0, 1, undefined);
    expect(h1.images.map((i) => i.id).sort()).toEqual([i0, i1].sort());
    expect(h1.truncated).toBe(false);

    const h2 = await neighbourhoodFrom(boardId, i0, 2, undefined);
    expect(h2.images.map((i) => i.id).sort()).toEqual([i0, i1, i2].sort());

    const h3 = await neighbourhoodFrom(boardId, i0, 3, undefined);
    expect(h3.images.map((i) => i.id).sort()).toEqual([i0, i1, i2, i3].sort());

    // hops are correct, not just set membership
    const byId = new Map(h3.images.map((i) => [i.id, i.hops]));
    expect(byId.get(i0)).toBe(0);
    expect(byId.get(i1)).toBe(1);
    expect(byId.get(i2)).toBe(2);
    expect(byId.get(i3)).toBe(3);

    // nearest-first ordering
    expect(h3.images.map((i) => i.id)).toEqual([i0, i1, i2, i3]);

    // edges among the returned images: exactly the 3 chain links spanned
    expect(h3.edges.length).toBe(3);
  });

  test('a relation filter narrows both the walk and the returned edges', async () => {
    const { boardId, images } = await makeChain();
    const i0 = at(images, 0);
    const i1 = at(images, 1);

    // img0 -[resembles]- img1 -[contradicts]- img2: filtering to
    // 'resembles' can cross edge 0 but not edge 1, so hops=3 still only
    // reaches img1.
    const filtered = await neighbourhoodFrom(boardId, i0, 3, 'resembles');
    expect(filtered.images.map((i) => i.id).sort()).toEqual([i0, i1].sort());
    for (const e of filtered.edges) expect(e.relation).toBe('resembles');

    const unfiltered = await neighbourhoodFrom(boardId, i0, 3, undefined);
    expect(unfiltered.images.length).toBe(4);
  });

  test('the cap truncates nearest-first', async () => {
    const { boardId, images } = await makeChain();
    const i0 = at(images, 0);
    const i1 = at(images, 1);

    const capped = await neighbourhoodFrom(boardId, i0, 3, undefined, 2);
    expect(capped.truncated).toBe(true);
    expect(capped.images.length).toBe(2);
    expect(capped.images.map((i) => i.id)).toEqual([i0, i1]);

    const uncapped = await neighbourhoodFrom(boardId, i0, 3, undefined, 150);
    expect(uncapped.truncated).toBe(false);
  });

  test('an edge is scoped to its board: a chain on another board is invisible', async () => {
    const a = await makeChain();
    const b = await makeChain();
    const fromA = at(a.images, 0);

    const result = await neighbourhoodFrom(a.boardId, fromA, 3, undefined);
    for (const img of result.images) {
      expect(b.images.includes(img.id)).toBe(false);
    }
  });
});
