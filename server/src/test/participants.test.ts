import { describe, expect, test } from 'bun:test';
// sheets/participants.ts: who has been in a sheet — stamps on its claims
// and replies to them — most recent first, five at most, each once.
import { pool } from '../db/pool.ts';
import { participantsOf } from '../sheets/participants.ts';

async function sheetWith(
  elements: unknown[],
): Promise<{ sheetId: string; boardId: string }> {
  const stamp = `${Date.now()}-${Math.random()}`;
  const { rows } = await pool.query(
    `INSERT INTO boards (org_id, name, open, created_by)
     VALUES ($1, 'p', true, 'tester') RETURNING id`,
    [`org-people-${stamp}`],
  );
  const boardId = rows[0].id as string;
  const { rows: sheet } = await pool.query(
    `INSERT INTO sheets (board_id, name, created_by) VALUES ($1, 'S', 'tester') RETURNING id`,
    [boardId],
  );
  const sheetId = sheet[0].id as string;
  await pool.query(
    'INSERT INTO sheet_snapshots (sheet_id, elements, saved_at) VALUES ($1, $2, now())',
    [sheetId, JSON.stringify(elements)],
  );
  return { sheetId, boardId };
}

const claim = (made: object, edited?: object) => ({
  id: crypto.randomUUID(),
  customData: { kind: 'region', made, ...(edited ? { edited } : {}) },
});

describe('participants', () => {
  test('stamps and replies, most recent first, each person once', async () => {
    const { sheetId, boardId } = await sheetWith([
      claim(
        { id: 'ada', name: 'Ada', at: '2026-09-20T10:00:00.000Z' },
        { id: 'bo', name: 'Bo', at: '2026-09-21T10:00:00.000Z' },
      ),
      claim({ id: 'ada', name: 'Ada', at: '2026-09-22T10:00:00.000Z' }),
      { id: 'img', customData: { kind: 'image', imageId: 'x' } },
    ]);
    // A reply from someone who exists as a user: named from the user row.
    const userId = `user-${Date.now()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, 'Cy', $2, false, now(), now())`,
      [userId, `${userId}@example.test`],
    );
    await pool.query(
      `INSERT INTO claim_replies (board_id, sheet_id, element_id, user_id, body, created_at)
       VALUES ($1, $2, 'el', $3, 'hello', '2026-09-23T10:00:00Z')`,
      [boardId, sheetId, userId],
    );
    const got = await participantsOf([sheetId]);
    expect(got.get(sheetId)).toEqual([
      { id: userId, name: 'Cy' },
      { id: 'ada', name: 'Ada' },
      { id: 'bo', name: 'Bo' },
    ]);
  });

  test('five at most, and a sheet with nobody has an empty list', async () => {
    const seven = Array.from({ length: 7 }, (_, i) =>
      claim({ id: `p${i}`, name: `P${i}`, at: `2026-09-2${i}T00:00:00.000Z` }),
    );
    const { sheetId } = await sheetWith(seven);
    const { sheetId: empty } = await sheetWith([]);
    const got = await participantsOf([sheetId, empty]);
    expect(got.get(sheetId)?.map((p) => p.id)).toEqual([
      'p6',
      'p5',
      'p4',
      'p3',
      'p2',
    ]);
    expect(got.get(empty)).toBeUndefined();
  });
});
