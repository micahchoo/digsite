import { afterAll, describe, expect, test } from 'bun:test';
import { parseSortId, sortId } from '@digsite/shared/board/sort';
import { FilterRefused, buildFilterSql } from '../boards/filter.ts';
import { findRanks } from '../boards/find.ts';
import { buildOf } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';

const boardId = crypto.randomUUID();

function requireSort(id: string) {
  const sort = parseSortId(id);
  if (!sort) throw new Error(`invalid fixture sort: ${id}`);
  return sort;
}

afterAll(async () => {
  await pool.query('DELETE FROM board_property_indexes WHERE board_id = $1', [
    boardId,
  ]);
  await pool.query('DELETE FROM board_rank_state WHERE board_id = $1', [
    boardId,
  ]);
  await pool.query('DELETE FROM images WHERE board_id = $1', [boardId]);
  await pool.query('DELETE FROM boards WHERE id = $1', [boardId]);
});

describe('find and typed property sorts', () => {
  test('filters dates and lists, returns selected ids in rank order, and preserves zero counts', async () => {
    await pool.query(
      `INSERT INTO boards (id, org_id, name, open, created_by)
       VALUES ($1, 'find-test', 'find-test', true, 'test-user')`,
      [boardId],
    );
    const rows = [
      {
        name: 'Gamma',
        properties: {
          day: '1987-03-14',
          year: 1987,
          site: 'archive',
          tags: ['zeta', 'blue'],
        },
      },
      {
        name: 'Alpha',
        properties: {
          day: '1986-01-02',
          year: 1986,
          site: 'archive',
          tags: ['alpha'],
        },
      },
      {
        name: 'Beta',
        properties: {
          year: 1995,
          site: 'field',
          tags: [],
        },
      },
    ];
    const imageIds: string[] = [];
    for (const [slot, image] of rows.entries()) {
      const { rows: inserted } = await pool.query(
        `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, properties)
         VALUES ($1, $2, $3, $4, 20, 20, 'test-user', $5) RETURNING id`,
        [
          boardId,
          slot,
          `find-test-${slot}-${boardId}`,
          image.name,
          image.properties,
        ],
      );
      imageIds.push(inserted[0].id);
    }
    await pool.query('UPDATE boards SET image_count = 3 WHERE id = $1', [
      boardId,
    ]);
    const alphaId = imageIds[1];
    const gammaId = imageIds[0];
    if (!alphaId || !gammaId) throw new Error('fixture insert returned no ids');

    expect(parseSortId('p.date.day.asc')).toEqual({
      key: { property: 'day', type: 'date' },
      dir: 'asc',
    });
    expect(parseSortId('p.list.tags.asc')).toEqual({
      key: { property: 'tags', type: 'list' },
      dir: 'asc',
    });

    const byDate = await findRanks(
      await buildOf(boardId, requireSort('p.date.day.asc')),
      null,
      [],
    );
    expect(byDate.imageIds.slice(0, 2)).toEqual([alphaId, gammaId]);
    expect(byDate.imageIds).toHaveLength(3);

    // Concurrent searches agree on substring matching, including an interior
    // term, and a trigram index serves it (0022_image_search_text.sql).
    const byDay = await buildOf(boardId, requireSort('p.date.day.asc'));
    const searches = await Promise.all(
      Array.from({ length: 10 }, () => findRanks(byDay, 'lph', [])),
    );
    for (const result of searches) {
      expect(result.imageIds).toEqual([alphaId]);
      expect(result.count).toBe(1);
    }
    const { rows: indexes } = await pool.query(
      "SELECT 1 FROM pg_indexes WHERE indexname = 'images_search_text_trgm'",
    );
    expect(indexes).toHaveLength(1);

    const matching = await findRanks(
      await buildOf(boardId, requireSort('p.list.tags.asc')),
      null,
      [
        { key: 'year', op: 'between', value: [1980, 1990] },
        { key: 'site', op: 'eq', value: 'archive' },
        { key: 'tags', op: 'has', value: 'blue' },
      ],
    );
    expect(matching.count).toBe(1);
    expect(matching.imageIds).toEqual([gammaId]);
    expect(matching.ranks).toHaveLength(1);

    const empty = await findRanks(
      await buildOf(boardId, requireSort('uploaded_at.desc')),
      null,
      [{ key: 'site', op: 'eq', value: 'missing' }],
    );
    expect(empty.count).toBe(0);
    expect(empty.ranks).toEqual([]);
    expect(empty.imageIds).toEqual([]);
  });
});

describe('a filter the grammar refuses', () => {
  test('is FilterRefused, which the route answers 400; nothing else is', async () => {
    await expect(
      buildFilterSql(boardId, [{ key: '', op: 'eq', value: 1 } as never], 1),
    ).rejects.toBeInstanceOf(FilterRefused);
    await expect(
      buildFilterSql(
        boardId,
        [{ key: 'name', op: 'nope', value: 1 } as never],
        1,
      ),
    ).rejects.toBeInstanceOf(FilterRefused);
  });
});
