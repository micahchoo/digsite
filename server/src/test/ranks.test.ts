// docs/design.md "Tests": a board of 20 images; each sort's ranks are a
// permutation of the slots; a property sort puts missing values last; an
// upload marks the state stale and the next ensureRank rebuilds.
import { describe, expect, test } from 'bun:test';
import { type Sort, sortId } from '@digsite/shared/board/sort';
import {
  buildOf,
  ensureRank,
  forceRebuildRank,
  imageIdsInRankBand,
  rankOf,
  rankOrder,
  sweepStaleRanks,
} from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';

/** The order as a list of slots, rank 0 first. */
async function slotsInOrder(boardId: string, sort: Sort): Promise<number[]> {
  return [...(await rankOrder(boardId, sort)).slotOfRank];
}

async function idsAtSlots(boardId: string, slots: number[]): Promise<string[]> {
  const { rows } = await pool.query(
    'SELECT slot, id FROM images WHERE board_id = $1 AND slot = ANY($2::int[])',
    [boardId, slots],
  );
  const idOf = new Map(rows.map((row) => [row.slot, row.id]));
  return slots.map((slot) => idOf.get(slot));
}

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

    const forward = await imageIdsInRankBand(
      await buildOf(boardId, sort),
      0,
      18,
      150,
    );
    const reverse = await imageIdsInRankBand(
      await buildOf(boardId, sort),
      18,
      0,
      150,
    );
    const order = await slotsInOrder(boardId, sort);
    const expected = await idsAtSlots(
      boardId,
      [0, 1, 2, 16, 17, 18].map((rank) => order[rank] as number),
    );
    expect(forward).toEqual(expected);
    expect(reverse).toEqual(forward);

    const capped = await imageIdsInRankBand(
      await buildOf(boardId, sort),
      0,
      255,
      150,
    );
    expect(capped).toHaveLength(150);
    const { rows: cappedRows } = await pool.query(
      'SELECT slot FROM images WHERE id = ANY($1::uuid[])',
      [capped],
    );
    const decoded = await rankOrder(boardId, sort);
    expect(
      cappedRows.map((row) => rankOf(decoded, row.slot)).sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 150 }, (_, rank) => rank));
    expect(
      await imageIdsInRankBand(await buildOf(boardId, sort), 300, 302, 150),
    ).toEqual([]);
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
      const slots = await slotsInOrder(boardId, sort);
      expect([...slots].sort((a, b) => a - b)).toEqual([...Array(N).keys()]);
    }

    // property sort ascending: images with no "year" property sort last.
    const propSort: Sort = {
      key: { property: 'year', type: 'number' },
      dir: 'asc',
    };
    const propRanked = await slotsInOrder(boardId, propSort);
    const tail = propRanked.slice(N - missingSlots.size);
    for (const slot of tail) expect(missingSlots.has(slot)).toBe(true);
    const head = propRanked.slice(0, N - missingSlots.size);
    for (const slot of head) expect(missingSlots.has(slot)).toBe(false);

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
    // the same way change.ts#boardChanged (upload's caller) sets `stale`
    // directly rather than going through a request.
    await pool.query(
      `UPDATE board_rank_state SET last_requested_at = now() - interval '10 days'
       WHERE board_id = $1 AND sort_id = $2`,
      [boardId, sortId(staleSort)],
    );

    const swept = await sweepStaleRanks(7);
    expect(swept.sorts).toBeGreaterThanOrEqual(1);

    const { rows: staleRows } = await pool.query(
      'SELECT 1 FROM board_rank_state WHERE board_id = $1 AND sort_id = $2',
      [boardId, sortId(staleSort)],
    );
    expect(staleRows.length).toBe(0);

    const { rows: freshRows } = await pool.query(
      'SELECT 1 FROM board_rank_state WHERE board_id = $1 AND sort_id = $2',
      [boardId, sortId(freshSort)],
    );
    expect(freshRows.length).toBe(1);

    // swept sort rebuilds transparently on its next request, same path a
    // stale one already takes.
    const { built } = await ensureRank(boardId, staleSort);
    expect(built).toBe(true);
    expect(await slotsInOrder(boardId, staleSort)).toHaveLength(5);
  });

  test('two concurrent rebuilds of the same (board, sort) both resolve and the order holds exactly N slots', async () => {
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
    // two rebuilds racing like this reproduced a duplicate-key error on the
    // owner's demo server, when ranks were rows in board_ranks. The order is
    // one value now, but the lock still keeps two builds from both doing
    // the work. Firing forceRebuildRank (never skips on `stale`, so
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

    const slots = await slotsInOrder(boardId, sort);
    expect([...slots].sort((a, b) => a - b)).toEqual([...Array(N).keys()]);
  }, 20_000); // two real 5,000-row rebuilds exceed bun:test's default 5s
  // per-test timeout even on the fixed, non-racing path.
});
