import { describe, expect, test } from 'bun:test';
// Roadmap C1: materialise used to stamp materialised_at whatever order it
// had drawn. A rebuild during the run was then marked materialised, and the
// map served coarse tiles in the old order until the next materialise.
import { type Sort, sortId } from '@digsite/shared/board/sort';
import { stampMaterialised } from '../boards/materialise.ts';
import { forceRebuildRank, rankOrder } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';

const sort: Sort = { key: 'name', dir: 'asc' };

async function boardWithImages(n: number): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO boards (org_id, name, open, created_by, image_count)
     VALUES ('org-stamp', $1, true, 'tester', $2) RETURNING id`,
    [`stamp-${Date.now()}`, n],
  );
  const boardId = rows[0].id as string;
  for (let slot = 0; slot < n; slot++) {
    await pool.query(
      `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, properties)
       VALUES ($1, $2, $3, $4, 10, 10, 'tester', '{}')`,
      [boardId, slot, `sha-${slot}`, `img-${slot}`],
    );
  }
  return boardId;
}

async function materialisedAt(boardId: string): Promise<Date | null> {
  const { rows } = await pool.query(
    'SELECT materialised_at FROM board_rank_state WHERE board_id = $1 AND sort_id = $2',
    [boardId, sortId(sort)],
  );
  return rows[0]?.materialised_at ?? null;
}

describe('materialise stamps only the order it drew', () => {
  test('a rebuild during the run leaves the sort unmaterialised', async () => {
    const boardId = await boardWithImages(4);
    const drawn = (await rankOrder(boardId, sort)).version;
    await forceRebuildRank(boardId, sort); // lands while "materialise" runs
    expect(await stampMaterialised(boardId, sortId(sort), drawn)).toBe(false);
    expect(await materialisedAt(boardId)).toBeNull();
  });

  test('with no rebuild in between, the stamp lands', async () => {
    const boardId = await boardWithImages(4);
    const drawn = (await rankOrder(boardId, sort)).version;
    expect(await stampMaterialised(boardId, sortId(sort), drawn)).toBe(true);
    expect(await materialisedAt(boardId)).not.toBeNull();
  });
});
