// docs/design.md "Tests": a board of 20 images; each sort's ranks are a
// permutation of the slots; a property sort puts missing values last; an
// upload marks the state stale and the next ensureRank rebuilds.
import { describe, expect, test } from 'bun:test';
import { type Sort, sortId } from '@digsite/shared/board/sort';
import {
  ensureRank,
  forceRebuildRank,
  imageIdsInRankBand,
  sweepStaleRanks,
} from '../boards/ranks.ts';
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
  name: string,
  properties: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, properties)
     VALUES ($1,$2,$3,$4,100,100,'tester',$5)`,
    [
      boardId,
      slot,
      `sha-${slot}-${Date.now()}`,
      name,
      JSON.stringify(properties),
    ],
  );
}

describe('ranks', () => {
  test('rank band selects a rectangle in either drag direction and respects its cap', async () => {
    const boardId = await makeBoard(`rank-band-${Date.now()}`);
    const count = 256;
    for (let i = 0; i < count; i++) {
      await makeImage(boardId, i, `img-${String(i).padStart(3, '0')}`, {});
    }
    await pool.query('UPDATE boards SET image_count = $1 WHERE id = $2', [
      count,
      boardId,
    ]);
    const sort: Sort = { key: 'name', dir: 'asc' };
    await ensureRank(boardId, sort);

    const forward = await imageIdsInRankBand(boardId, sort, 0, 18, 150);
    const reverse = await imageIdsInRankBand(boardId, sort, 18, 0, 150);
    const expected = await pool.query(
      `SELECT i.id FROM board_ranks br
       JOIN images i ON i.board_id = br.board_id AND i.slot = br.slot
       WHERE br.board_id = $1 AND br.sort_id = $2
         AND br.rank IN (0, 1, 2, 16, 17, 18)
       ORDER BY br.rank`,
      [boardId, sortId(sort)],
    );
    expect(forward).toEqual(expected.rows.map((row) => row.id));
    expect(reverse).toEqual(forward);

    const capped = await imageIdsInRankBand(boardId, sort, 0, 255, 150);
    expect(capped).toHaveLength(150);
    const cappedRanks = await pool.query(
      `SELECT rank FROM board_ranks
       WHERE board_id = $1 AND sort_id = $2 AND slot = ANY(
         SELECT slot FROM images WHERE id = ANY($3::uuid[])
       ) ORDER BY rank`,
      [boardId, sortId(sort), capped],
    );
    expect(cappedRanks.rows.map((row) => row.rank)).toEqual(
      Array.from({ length: 150 }, (_, rank) => rank),
    );
    expect(await imageIdsInRankBand(boardId, sort, 300, 302, 150)).toEqual([]);
  });

  test('ranks are a permutation of slots; property sort NULLS LAST; stale marks a rebuild', async () => {
    const boardId = await makeBoard(`ranks-test-${Date.now()}`);
    const N = 20;
    const missingSlots = new Set<number>();

    for (let i = 0; i < N; i++) {
      const hasYear = i % 5 !== 0;
      if (!hasYear) missingSlots.add(i);
      const properties = hasYear ? { year: 2000 + ((N - i) % N) } : {};
      // zero-padded names in reverse order so name.asc isn't slot order —
      // a real permutation, not a coincidence of insertion order.
      await makeImage(
        boardId,
        i,
        `img-${String(N - i).padStart(3, '0')}`,
        properties,
      );
    }
    await pool.query('UPDATE boards SET image_count = $1 WHERE id = $2', [
      N,
      boardId,
    ]);

    const nameSort: Sort = { key: 'name', dir: 'asc' };
    const sorts: Sort[] = [
      nameSort,
      { key: 'uploaded_at', dir: 'desc' },
      { key: { property: 'year', type: 'number' }, dir: 'asc' },
    ];

    for (const sort of sorts) {
      const { built } = await ensureRank(boardId, sort);
      expect(built).toBe(true);
      const { rows } = await pool.query(
        'SELECT rank, slot FROM board_ranks WHERE board_id = $1 AND sort_id = $2 ORDER BY rank',
        [boardId, sortId(sort)],
      );
      expect(rows.length).toBe(N);
      const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
      expect(ranks).toEqual([...Array(N).keys()]);
      const slots = rows.map((r) => r.slot).sort((a, b) => a - b);
      expect(slots).toEqual([...Array(N).keys()]);
    }

    // property sort ascending: images with no "year" property sort last.
    const propSort: Sort = {
      key: { property: 'year', type: 'number' },
      dir: 'asc',
    };
    const { rows: propRanked } = await pool.query(
      'SELECT rank, slot FROM board_ranks WHERE board_id = $1 AND sort_id = $2 ORDER BY rank',
      [boardId, sortId(propSort)],
    );
    const tail = propRanked.slice(N - missingSlots.size);
    for (const row of tail) expect(missingSlots.has(row.slot)).toBe(true);
    const head = propRanked.slice(0, N - missingSlots.size);
    for (const row of head) expect(missingSlots.has(row.slot)).toBe(false);

    // an upload (simulated here by the same stale flag it sets) marks the
    // state stale; ensureRank rebuilds once, then reports no rebuild needed.
    await pool.query(
      'UPDATE board_rank_state SET stale = true WHERE board_id = $1',
      [boardId],
    );
    const rebuilt = await ensureRank(boardId, nameSort);
    expect(rebuilt.built).toBe(true);
    const skipped = await ensureRank(boardId, nameSort);
    expect(skipped.built).toBe(false);
  });

  test('sweepStaleRanks drops only (board, sort) pairs unrequested past the threshold, and ensureRank transparently rebuilds one it swept', async () => {
    const boardId = await makeBoard(`sweep-test-${Date.now()}`);
    for (let i = 0; i < 5; i++) {
      await makeImage(boardId, i, `img-${i}`, {});
    }
    await pool.query('UPDATE boards SET image_count = $1 WHERE id = $2', [
      5,
      boardId,
    ]);

    const freshSort: Sort = { key: 'uploaded_at', dir: 'desc' };
    const staleSort: Sort = { key: 'name', dir: 'asc' };
    await ensureRank(boardId, freshSort);
    await ensureRank(boardId, staleSort);

    // backdate only the stale sort's last_requested_at past the threshold —
    // touchLastRequested (ranks.ts) is throttled to update on read, so a
    // test exercising the sweep itself has to set the clock back directly,
    // the same way markBoardRanksStale's own caller (upload) sets `stale`
    // directly rather than going through a request.
    await pool.query(
      `UPDATE board_rank_state SET last_requested_at = now() - interval '10 days'
       WHERE board_id = $1 AND sort_id = $2`,
      [boardId, sortId(staleSort)],
    );

    const swept = await sweepStaleRanks(7);
    expect(swept.sorts).toBeGreaterThanOrEqual(1);
    expect(swept.rows).toBeGreaterThanOrEqual(5);

    const { rows: staleRows } = await pool.query(
      'SELECT 1 FROM board_rank_state WHERE board_id = $1 AND sort_id = $2',
      [boardId, sortId(staleSort)],
    );
    expect(staleRows.length).toBe(0);
    const { rows: staleRankRows } = await pool.query(
      'SELECT 1 FROM board_ranks WHERE board_id = $1 AND sort_id = $2',
      [boardId, sortId(staleSort)],
    );
    expect(staleRankRows.length).toBe(0);

    const { rows: freshRows } = await pool.query(
      'SELECT 1 FROM board_rank_state WHERE board_id = $1 AND sort_id = $2',
      [boardId, sortId(freshSort)],
    );
    expect(freshRows.length).toBe(1);

    // swept sort rebuilds transparently on its next request, same path a
    // stale one already takes.
    const { built } = await ensureRank(boardId, staleSort);
    expect(built).toBe(true);
    const { rows: rebuiltRows } = await pool.query(
      'SELECT rank, slot FROM board_ranks WHERE board_id = $1 AND sort_id = $2',
      [boardId, sortId(staleSort)],
    );
    expect(rebuiltRows.length).toBe(5);
  });

  test('two concurrent rebuilds of the same (board, sort) both resolve and the table ends with exactly N rows', async () => {
    const boardId = await makeBoard(`concurrent-rebuild-test-${Date.now()}`);
    const N = 5000;
    for (let i = 0; i < N; i++) {
      await makeImage(boardId, i, `img-${String(N - i).padStart(3, '0')}`, {});
    }
    await pool.query('UPDATE boards SET image_count = $1 WHERE id = $2', [
      N,
      boardId,
    ]);

    const sort: Sort = { key: 'name', dir: 'asc' };

    // Before the advisory lock (server/src/boards/ranks.ts#rebuildRank),
    // two rebuilds racing like this reproduced
    // `duplicate key value violates unique constraint "board_ranks_..._pkey"`
    // on the owner's demo server — both compute and INSERT the identical
    // target row set. Firing forceRebuildRank (never skips on `stale`, so
    // both calls definitely attempt a real rebuild, not one short-circuiting
    // on ensureRank's own pre-check) twice at once is the sharpest
    // reproduction of that race. N=5000 matters: confirmed by hand that a
    // smaller N (30) does not reliably overlap two Promise.all-fired calls
    // enough to trigger it — the DELETE+INSERT completes too fast locally
    // for the race window to open reliably at that size, even without the
    // fix. Reverting the lock+re-check above and re-running this test at
    // N=5000 reproduces the exact reported error in ~7s.
    const results = await Promise.allSettled([
      forceRebuildRank(boardId, sort),
      forceRebuildRank(boardId, sort),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') {
        throw new Error(`concurrent rebuild rejected: ${r.reason}`);
      }
    }

    const { rows } = await pool.query(
      'SELECT rank, slot FROM board_ranks WHERE board_id = $1 AND sort_id = $2 ORDER BY rank',
      [boardId, sortId(sort)],
    );
    expect(rows.length).toBe(N);
    const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
    expect(ranks).toEqual([...Array(N).keys()]);
  }, 20_000); // two real 5,000-row rebuilds exceed bun:test's default 5s
  // per-test timeout even on the fixed, non-racing path.
});
