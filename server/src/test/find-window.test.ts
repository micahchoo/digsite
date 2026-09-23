import { describe, expect, test } from 'bun:test';
// boards/find.ts with a window: every match inside the ranks asked for,
// past the cap an unwindowed find keeps, and nothing outside them.
import { findRanks } from '../boards/find.ts';
import { buildOf } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';

describe('find in a window', () => {
  test('every match inside, none outside, no cap within', async () => {
    const { rows } = await pool.query(
      `INSERT INTO boards (org_id, name, open, created_by, image_count)
       VALUES ($1, 'w', true, 'tester', 15000) RETURNING id`,
      [`org-window-${Date.now()}`],
    );
    const boardId = rows[0].id as string;
    await pool.query(
      `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, properties)
       SELECT $1, s, 'sha-' || s, 'img-' || lpad(s::text, 5, '0'), 1, 1, 'tester', '{}'
       FROM generate_series(0, 14999) s`,
      [boardId],
    );
    const build = await buildOf(boardId, { key: 'name', dir: 'asc' });
    const all = await findRanks(build, null, []);
    expect([all.count, all.ranks.length]).toEqual([15000, 10000]);
    const wide = await findRanks(build, null, [], {}, { from: 0, to: 14999 });
    expect([wide.count, wide.ranks.length]).toEqual([15000, 15000]);
    const narrow = await findRanks(
      build,
      'img-001',
      [],
      {},
      { from: 100, to: 199 },
    );
    expect(narrow.ranks).toEqual(
      Array.from({ length: 100 }, (_, i) => 100 + i),
    );
  });
});
