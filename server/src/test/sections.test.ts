// docs/phases/1-map.md "Tests": a board with years 1900..1905 gives six
// sections with the right rank ranges under p.number.year.asc.
import { describe, expect, test } from 'bun:test';
import type { Sort } from '@digsite/shared/board/sort';
import { buildOf, ensureRank } from '../boards/ranks.ts';
import { sectionsFor } from '../boards/sections.ts';
import { pool } from '../db/pool.ts';

async function makeBoard(name: string): Promise<string> {
  const { rows } = await pool.query(
    'INSERT INTO boards (org_id, name, open, created_by) VALUES ($1,$2,true,$3) RETURNING id',
    [`org-test-${Date.now()}`, name, 'test-user'],
  );
  return rows[0].id;
}

async function makeImage(
  boardId: string,
  slot: number,
  properties: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, properties)
     VALUES ($1,$2,$3,$4,10,10,'tester',$5)`,
    [boardId, slot, `sha-${slot}`, `img-${slot}`, JSON.stringify(properties)],
  );
}

const YEAR_SORT: Sort = {
  key: { property: 'year', type: 'number' },
  dir: 'asc',
};

describe('sections', () => {
  test('years 1900..1905 give six sections with contiguous rank ranges', async () => {
    const boardId = await makeBoard(`sections-test-${Date.now()}`);
    const years = [1900, 1900, 1901, 1902, 1902, 1902, 1903, 1904, 1905, 1905];
    for (const [i, year] of years.entries()) {
      await makeImage(boardId, i, { year });
    }
    await pool.query('UPDATE boards SET image_count = $1 WHERE id = $2', [
      years.length,
      boardId,
    ]);

    await ensureRank(boardId, YEAR_SORT);
    const { sections, truncated } = await sectionsFor(
      await buildOf(boardId, YEAR_SORT),
    );

    expect(truncated).toBe(false);
    expect(sections.length).toBe(6);
    expect(sections.map((s) => s.label)).toEqual([
      '1900',
      '1901',
      '1902',
      '1903',
      '1904',
      '1905',
    ]);

    let expectedFrom = 0;
    const uniqueYears = [1900, 1901, 1902, 1903, 1904, 1905];
    for (const [i, year] of uniqueYears.entries()) {
      const count = years.filter((y) => y === year).length;
      const section = sections[i];
      if (!section) throw new Error(`missing section ${i}`);
      expect(section.fromRank).toBe(expectedFrom);
      expect(section.toRank).toBe(expectedFrom + count - 1);
      expectedFrom += count;
    }
    const last = sections.at(-1);
    if (!last) throw new Error('no sections');
    expect(last.toRank).toBe(years.length - 1);
  });

  test('images missing the sort property land in one trailing section labelled —', async () => {
    const boardId = await makeBoard(`sections-missing-test-${Date.now()}`);
    await makeImage(boardId, 0, { year: 2000 });
    await makeImage(boardId, 1, {}); // no "year"
    await makeImage(boardId, 2, {}); // no "year"
    await pool.query('UPDATE boards SET image_count = 3 WHERE id = $1', [
      boardId,
    ]);

    await ensureRank(boardId, YEAR_SORT);
    const { sections } = await sectionsFor(await buildOf(boardId, YEAR_SORT));

    expect(sections.length).toBe(2);
    const [withYear, missing] = sections;
    if (!withYear || !missing) throw new Error('expected two sections');
    expect(withYear.label).toBe('2000');
    expect(withYear.fromRank).toBe(0);
    expect(withYear.toRank).toBe(0);
    expect(missing.label).toBe('—');
    expect(missing.fromRank).toBe(1);
    expect(missing.toRank).toBe(2);
  });
});
