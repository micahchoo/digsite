import { describe, expect, test } from 'bun:test';
// Roadmap item 2: find's text match through images.search_text
// (0022_image_search_text.sql). The meaning must not change: a term matches
// inside the name or inside ONE property value; LIKE wildcards in a term
// are literal.
import type { Sort } from '@digsite/shared/board/sort';
import { containsPattern, findRanks } from '../boards/find.ts';
import { buildOf } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';

const byName: Sort = { key: 'name', dir: 'asc' };

async function board(
  images: { name: string; properties?: Record<string, unknown> }[],
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO boards (org_id, name, open, created_by, image_count)
     VALUES ('org-find', $1, true, 'tester', $2) RETURNING id`,
    [`find-${Date.now()}-${Math.random()}`, images.length],
  );
  const boardId = rows[0].id as string;
  for (const [slot, image] of images.entries()) {
    await pool.query(
      `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, properties)
       VALUES ($1, $2, $3, $4, 10, 10, 'tester', $5)`,
      [
        boardId,
        slot,
        `sha-${slot}`,
        image.name,
        JSON.stringify(image.properties ?? {}),
      ],
    );
  }
  return boardId;
}

async function names(boardId: string, q: string): Promise<string[]> {
  const found = await findRanks(await buildOf(boardId, byName), q, []);
  const { rows } = await pool.query(
    'SELECT id, name FROM images WHERE id = ANY($1::uuid[])',
    [found.imageIds],
  );
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return found.imageIds.map((id) => byId.get(id)).sort();
}

describe('find by text', () => {
  test('matches the name or a property value, case-insensitively', async () => {
    const id = await board([
      { name: 'harbour.jpg' },
      { name: 'b.jpg', properties: { place: 'Old Harbour Road' } },
      { name: 'c.jpg', properties: { place: 'hill' } },
    ]);
    expect(await names(id, 'HARBOUR')).toEqual(['b.jpg', 'harbour.jpg']);
  });

  test('a term never matches across two values', async () => {
    const id = await board([
      { name: 'a.jpg', properties: { x: 'red', y: 'door' } },
      { name: 'b.jpg', properties: { x: 'red door' } },
    ]);
    // 'reddoor' is not in any one value; nor is a term spanning the name.
    expect(await names(id, 'reddoor')).toEqual([]);
    expect(await names(id, 'jpgred')).toEqual([]);
    expect(await names(id, 'red door')).toEqual(['b.jpg']);
  });

  test('% and _ match themselves, not anything', async () => {
    const id = await board([
      { name: 'a_b.jpg' },
      { name: 'axb.jpg' },
      { name: '100%.png' },
      { name: '1000.png' },
    ]);
    expect(await names(id, 'a_b')).toEqual(['a_b.jpg']);
    expect(await names(id, '0%')).toEqual(['100%.png']);
    expect(containsPattern('a\\b')).toBe('%a\\\\b%');
  });

  test('another board is never searched', async () => {
    const mine = await board([{ name: 'mine.jpg' }]);
    await board([{ name: 'mine-too.jpg' }]);
    expect(await names(mine, 'mine')).toEqual(['mine.jpg']);
  });
});
