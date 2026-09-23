import { describe, expect, test } from 'bun:test';
// boards/removal.ts: what removing an image, a sheet or a board takes
// with it — the rows, the stored objects and the group's quota — asked
// of the module, not of a route.
import sharp from 'sharp';
import { removeBoard, removeImage, removeSheet } from '../boards/removal.ts';
import { uploadOne } from '../boards/upload.ts';
import { pool } from '../db/pool.ts';
import { storageOf } from '../storage/quota.ts';

const png = (hue: number) =>
  sharp({
    create: {
      width: 48,
      height: 48,
      channels: 3,
      background: { r: hue, g: 60, b: 90 },
    },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();

async function groupBoard() {
  const orgId = `org-removal-${Date.now()}-${Math.random()}`;
  const { rows } = await pool.query(
    `INSERT INTO boards (org_id, name, open, created_by)
     VALUES ($1, 'r', true, 'tester') RETURNING id`,
    [orgId],
  );
  await pool.query('INSERT INTO group_storage (org_id) VALUES ($1)', [orgId]);
  return { orgId, boardId: rows[0].id as string };
}

async function imageRow(id: string) {
  const { rows } = await pool.query('SELECT * FROM images WHERE id = $1', [id]);
  return rows[0];
}

async function count(sql: string, id: string): Promise<number> {
  const { rows } = await pool.query(sql, [id]);
  return Number(rows[0].n);
}

describe('removal', () => {
  test('a shared original is paid back only when its last image goes', async () => {
    const { orgId, boardId } = await groupBoard();
    const bytes = new Uint8Array(await png(40));
    const a = await uploadOne(boardId, 'tester', 'a.png', bytes);
    const b = await uploadOne(boardId, 'tester', 'b.png', bytes);
    expect((await storageOf(orgId)).usedBytes).toBe(bytes.length);

    await removeImage(await imageRow(a.id));
    expect((await storageOf(orgId)).usedBytes).toBe(bytes.length);
    expect((await imageRow(a.id)).missing).toBe(true);

    await removeImage(await imageRow(b.id));
    expect((await storageOf(orgId)).usedBytes).toBe(0);
  });

  test('removing a missing image again changes nothing', async () => {
    const { orgId, boardId } = await groupBoard();
    const one = new Uint8Array(await png(70));
    const a = await uploadOne(boardId, 'tester', 'a.png', one);
    await uploadOne(boardId, 'tester', 'b.png', new Uint8Array(await png(71)));
    await removeImage(await imageRow(a.id));
    const after = (await storageOf(orgId)).usedBytes;
    await removeImage(await imageRow(a.id));
    expect((await storageOf(orgId)).usedBytes).toBe(after);
  });

  test("a board's removal gives its group back every byte it stored", async () => {
    const { orgId, boardId } = await groupBoard();
    const keep = await groupBoard();
    const x = new Uint8Array(await png(100));
    const y = new Uint8Array(await png(101));
    await uploadOne(boardId, 'tester', 'x.png', x);
    await uploadOne(boardId, 'tester', 'x-again.png', x);
    const gone = await uploadOne(boardId, 'tester', 'y.png', y);
    await removeImage(await imageRow(gone.id));
    // A second board in another group is untouched.
    await uploadOne(keep.boardId, 'tester', 'k.png', x);

    await removeBoard(boardId);

    expect((await storageOf(orgId)).usedBytes).toBe(0);
    expect((await storageOf(keep.orgId)).usedBytes).toBe(x.length);
    expect(
      await count(
        'SELECT count(*) AS n FROM images WHERE board_id = $1',
        boardId,
      ),
    ).toBe(0);
    expect(
      await count('SELECT count(*) AS n FROM boards WHERE id = $1', boardId),
    ).toBe(0);
  });

  test("a sheet's removal takes its own rows and leaves the board's", async () => {
    const { boardId } = await groupBoard();
    const mk = async (name: string) => {
      const { rows } = await pool.query(
        `INSERT INTO sheets (board_id, name, created_by)
         VALUES ($1, $2, 'tester') RETURNING id`,
        [boardId, name],
      );
      return rows[0].id as string;
    };
    const gone = await mk('gone');
    const kept = await mk('kept');
    for (const sheet of [gone, kept]) {
      await pool.query(
        `INSERT INTO sheet_reads (sheet_id, user_id, seen_at)
         VALUES ($1, 'tester', now())`,
        [sheet],
      );
    }

    await removeSheet(gone);

    const reads = 'SELECT count(*) AS n FROM sheet_reads WHERE sheet_id = $1';
    expect(await count(reads, gone)).toBe(0);
    expect(await count(reads, kept)).toBe(1);
    expect(
      await count(
        'SELECT count(*) AS n FROM sheets WHERE board_id = $1',
        boardId,
      ),
    ).toBe(1);
  });
});
