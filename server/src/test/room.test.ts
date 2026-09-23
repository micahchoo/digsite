import { afterEach, describe, expect, test } from 'bun:test';
// storage/room.ts: uploads stop before the data volume fills. Forced here
// by asking for more free space than any test disk has.
import sharp from 'sharp';
import { uploadOne } from '../boards/upload.ts';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { StorageFull, freeFrom, resetRoomForTest } from '../storage/room.ts';

const before = env.UPLOAD_MIN_FREE_GB;
afterEach(() => {
  env.UPLOAD_MIN_FREE_GB = before;
  resetRoomForTest();
});

async function board(): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO boards (org_id, name, open, created_by)
     VALUES ('org-room', $1, true, 'tester') RETURNING id`,
    [`room-${Date.now()}`],
  );
  return rows[0].id;
}

const png = () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: '#48c' } })
    .png()
    .toBuffer();

describe('room on the data volume', () => {
  test('an upload that would leave too little free space is refused, and nothing is stored', async () => {
    const boardId = await board();
    env.UPLOAD_MIN_FREE_GB = 1_000_000; // a petabyte free: no disk has it
    resetRoomForTest();
    await expect(
      uploadOne(boardId, 'tester', 'a.png', await png()),
    ).rejects.toBeInstanceOf(StorageFull);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM images WHERE board_id = $1',
      [boardId],
    );
    expect(rows[0].n).toBe(0);
  });

  test('0 turns the guard off', async () => {
    const boardId = await board();
    env.UPLOAD_MIN_FREE_GB = 0;
    resetRoomForTest();
    const uploaded = await uploadOne(boardId, 'tester', 'a.png', await png());
    expect(uploaded.status).toBe('pending');
  });

  test('a volume with more than 2^31 free blocks reads as free, not negative', () => {
    // The 24 TB volume this was found on: 3,645,209,126 blocks of 4 KiB.
    expect(freeFrom({ bavail: 3_645_209_126n, bsize: 4096n })).toBe(
      3_645_209_126 * 4096,
    );
  });

  test('the real data volume reads as positive', async () => {
    env.UPLOAD_MIN_FREE_GB = 1;
    resetRoomForTest();
    const boardId = await board();
    const uploaded = await uploadOne(boardId, 'tester', 'b.png', await png());
    expect(uploaded.status).toBe('pending');
  });
});
