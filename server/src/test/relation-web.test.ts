import { describe, expect, test } from 'bun:test';
// sheets/neighbourhood.ts#boardWeb: every connection meaning one
// relation (aliases included), across the board's sheets; its pictures,
// the most connected kept when it must be cut.
import { putAlias } from '../boards/vocabulary.ts';
import { pool } from '../db/pool.ts';
import { boardWeb } from '../sheets/neighbourhood.ts';

async function board(): Promise<{
  boardId: string;
  sheetId: string;
  img: string[];
}> {
  const stamp = `${Date.now()}-${Math.random()}`;
  const { rows } = await pool.query(
    `INSERT INTO boards (org_id, name, open, created_by)
     VALUES ($1, 'w', true, 'tester') RETURNING id`,
    [`org-web-${stamp}`],
  );
  const boardId = rows[0].id as string;
  const { rows: sheet } = await pool.query(
    `INSERT INTO sheets (board_id, name, created_by) VALUES ($1, 'S', 'tester') RETURNING id`,
    [boardId],
  );
  const img: string[] = [];
  for (let slot = 0; slot < 6; slot++) {
    const { rows: image } = await pool.query(
      `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by)
       VALUES ($1, $2, $3, $4, 1, 1, 'tester') RETURNING id`,
      [boardId, slot, `sha-web-${stamp}-${slot}`, `i${slot}`],
    );
    img.push(image[0].id);
  }
  return { boardId, sheetId: sheet[0].id, img };
}

let n = 0;
async function edge(sheetId: string, a: string, b: string, relation: string) {
  n++;
  const id = `web-${Date.now()}-${n}-${Math.random().toString(36).slice(2, 7)}`;
  await pool.query(
    `INSERT INTO edges (id, sheet_id, source_id, src_image_id, dst_image_id, direction, relation)
     VALUES ($1, $2, $1, $3, $4, 'forward', $5)`,
    [id, sheetId, a, b, relation],
  );
}

describe('the web of one relation', () => {
  test('every connection that means it, and no other; hubs kept first', async () => {
    const { boardId, sheetId, img } = await board();
    const [i0, i1, i2, i3, i4, i5] = img as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    // i0 is a hub of "copy of"; "duplicate of" means the same by alias.
    await edge(sheetId, i0, i1, 'copy of');
    await edge(sheetId, i0, i2, 'copy of');
    await edge(sheetId, i3, i0, 'duplicate of');
    await edge(sheetId, i4, i5, 'resembles');
    await putAlias(boardId, 'relation', 'duplicate of', 'copy of', 'tester');

    const web = await boardWeb(boardId, 'copy of');
    expect(web.images[0]).toEqual({ id: i0, hops: 0 });
    expect(web.images.map((i) => i.id).sort()).toEqual([i0, i1, i2, i3].sort());
    expect(web.edges).toHaveLength(3);
    expect(web.truncated).toBe(false);

    const cut = await boardWeb(boardId, 'copy of', 2);
    expect(cut.truncated).toBe(true);
    expect(cut.images[0]?.id).toBe(i0);
    // No relation: every connection, the board's whole web.
    const whole = await boardWeb(boardId, null);
    expect(whole.edges.length).toBeGreaterThanOrEqual(web.edges.length);
    expect(await boardWeb(boardId, 'nothing')).toEqual({
      images: [],
      edges: [],
      truncated: false,
    });
  });
});
