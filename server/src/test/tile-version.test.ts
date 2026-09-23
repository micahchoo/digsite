import { describe, expect, test } from 'bun:test';
// Roadmap item 7: every tile says which order build its pixels show, so a
// URL carrying that build's token can be cached for good. A miss, a hit of
// the composed cache and a materialised coarse tile each report the build
// they were drawn from; a pending cell makes a tile not final; a new build
// is a new version.
import { DEFAULT_SORT } from '@digsite/shared/board/sort';
import sharp from 'sharp';
import { materialiseSort } from '../boards/materialise.ts';
import { rankOrder } from '../boards/ranks.ts';
import { tileFor } from '../boards/tiles.ts';
import { uploadOne } from '../boards/upload.ts';
import { pool } from '../db/pool.ts';
import { drain } from '../worker/index.ts';

async function makeBoard(): Promise<string> {
  const { rows } = await pool.query(
    'INSERT INTO boards (org_id, name, open, created_by) VALUES ($1,$2,true,$3) RETURNING id',
    [`org-version-${Date.now()}`, `version-${Date.now()}`, 'tester'],
  );
  return rows[0].id;
}

const png = (hue: number) =>
  sharp({
    create: {
      width: 16,
      height: 16,
      channels: 3,
      background: { r: hue, g: 90, b: 40 },
    },
  })
    .png()
    .toBuffer();

describe('tile versions', () => {
  test('a miss, a hit and a new build each name the build they show', async () => {
    const boardId = await makeBoard();
    await uploadOne(boardId, 'tester', 'a.png', await png(10));
    await drain();
    const url = `/boards/${boardId}/tiles/uploaded_at.desc/0/0/0.png`;

    const first = await tileFor(boardId, DEFAULT_SORT, 0, 0, 0, 128, url);
    const v1 = (await rankOrder(boardId, DEFAULT_SORT)).version;
    expect([first.cache, first.version, first.final]).toEqual([
      'miss',
      v1,
      true,
    ]);

    const again = await tileFor(boardId, DEFAULT_SORT, 0, 0, 0, 128, url);
    expect([again.cache, again.version]).toEqual(['hit', v1]);

    // An upload: the new image is pending, the order is a new build.
    await uploadOne(boardId, 'tester', 'b.png', await png(200));
    const pending = await tileFor(boardId, DEFAULT_SORT, 0, 0, 0, 128, url);
    expect(pending.version).not.toBe(v1);
    expect(pending.final).toBe(false);

    await drain();
    const painted = await tileFor(boardId, DEFAULT_SORT, 0, 0, 0, 128, url);
    const v3 = (await rankOrder(boardId, DEFAULT_SORT)).version;
    expect([painted.version, painted.final]).toEqual([v3, true]);
    expect(v3).not.toBe(pending.version);
  });

  test('a materialised coarse tile names the build it was materialised from', async () => {
    const boardId = await makeBoard();
    await uploadOne(boardId, 'tester', 'a.png', await png(60));
    await drain();
    const v = (await rankOrder(boardId, DEFAULT_SORT)).version;
    await materialiseSort(boardId, DEFAULT_SORT);
    const url = `/boards/${boardId}/tiles/uploaded_at.desc/-3/0/0.png`;
    const tile = await tileFor(boardId, DEFAULT_SORT, -3, 0, 0, 16, url);
    expect([tile.cache, tile.version, tile.final]).toEqual([
      'resident',
      v,
      true,
    ]);
  });
});
