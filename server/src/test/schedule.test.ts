import { describe, expect, test } from 'bun:test';
// worker/schedule.ts: each kind declares how it coalesces; callers never
// spell the SQL. `settle` waits out a burst; `soon` makes sure a job is
// pending and never moves one (a read that settled the arrangement starved
// a watched board).
import { pool } from '../db/pool.ts';
import { schedule } from '../worker/schedule.ts';

async function pending(kind: string, boardId: string) {
  const { rows } = await pool.query(
    `SELECT run_after FROM jobs
     WHERE kind = $1 AND state = 'pending' AND payload->>'boardId' = $2`,
    [kind, boardId],
  );
  return rows.map((r) => (r.run_after as Date).getTime());
}

async function cleanup(boardId: string) {
  await pool.query(`DELETE FROM jobs WHERE payload->>'boardId' = $1`, [
    boardId,
  ]);
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('schedule', () => {
  test('a burst of settles leaves one job, moved out each time', async () => {
    const boardId = crypto.randomUUID();
    await schedule('arrange', { boardId });
    const [first] = await pending('arrange', boardId);
    await pause();
    await schedule('arrange', { boardId });
    await schedule('arrange', { boardId });
    const after = await pending('arrange', boardId);
    expect(after).toHaveLength(1);
    expect(after[0]).toBeGreaterThan(first as number);
    await cleanup(boardId);
  });

  test('soon queues a job due now, and never moves a pending one', async () => {
    const boardId = crypto.randomUUID();
    const before = Date.now();
    await schedule('arrange', { boardId }, 'soon');
    const queued = await pending('arrange', boardId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toBeLessThan(before + 5_000);
    for (let i = 0; i < 3; i++) {
      await pause();
      await schedule('arrange', { boardId }, 'soon');
    }
    expect(await pending('arrange', boardId)).toEqual(queued);
    await cleanup(boardId);
  });

  test('a kind that does not coalesce adds a job each time', async () => {
    const boardId = crypto.randomUUID();
    await schedule('materialise', { boardId, sortId: 'name.asc' });
    await schedule('materialise', { boardId, sortId: 'name.asc' });
    expect(await pending('materialise', boardId)).toHaveLength(2);
    await cleanup(boardId);
  });

  test('a coalescing kind without a board is refused', async () => {
    await expect(schedule('rank-rebuild', {})).rejects.toThrow('boardId');
  });
});
