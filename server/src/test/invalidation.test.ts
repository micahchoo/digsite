import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// boards/invalidation.ts across a real process boundary: a child process
// publishes, this process must drop what it holds. Before this module a
// worker process repainting a page left the API drawing the old one.
import { join } from 'node:path';
import {
  type Invalidation,
  catchUp,
  listenForInvalidation,
  publish,
} from '../boards/invalidation.ts';
import { getPage, residentPagesForTest } from '../boards/ladder.ts';
import { ensureRank } from '../boards/ranks.ts';
import {
  composedGeneration,
  getComposedTile,
  setComposedTile,
} from '../boards/tiles-cache.ts';
import { pool } from '../db/pool.ts';
import { onJobFailedFinal } from '../worker/jobs.ts';

const MODULE = join(import.meta.dir, '../boards/invalidation.ts');

/** Publishes from another process, as a separate worker would. */
async function publishFromChild(event: Invalidation): Promise<void> {
  const child = Bun.spawn(
    [
      'bun',
      '-e',
      `const m = await import(${JSON.stringify(MODULE)});
       await m.publish(${JSON.stringify(event)});
       process.exit(0);`,
    ],
    { env: process.env, stdout: 'inherit', stderr: 'inherit' },
  );
  expect(await child.exited).toBe(0);
}

async function until(check: () => boolean, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

describe('invalidation across processes', () => {
  let stop: () => void;
  beforeAll(async () => {
    stop = listenForInvalidation();
    // LISTEN is registered asynchronously; give the connection time.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  afterAll(() => stop());

  test('a page repainted elsewhere leaves this process', async () => {
    const boardId = crypto.randomUUID();
    await getPage(boardId, 32, 0);
    expect(residentPagesForTest(boardId)).toBe(1);
    await publishFromChild({ kind: 'page', boardId, s: 32, page: 0 });
    expect(await until(() => residentPagesForTest(boardId) === 0)).toBe(true);
  });

  test('ranks changed elsewhere drop composed tiles here', async () => {
    const boardId = crypto.randomUUID();
    const url = `/boards/${boardId}/tiles/name.asc/0/0/0.png`;
    setComposedTile(
      url,
      boardId,
      Buffer.from('tile'),
      composedGeneration(boardId),
      'v1',
    );
    await publishFromChild({ kind: 'ranks', boardId });
    expect(await until(() => getComposedTile(url) === undefined)).toBe(true);
  });

  test('a process ignores what it published itself', async () => {
    const boardId = crypto.randomUUID();
    await getPage(boardId, 32, 0);
    await publish({ kind: 'page', boardId, s: 32, page: 0 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(residentPagesForTest(boardId)).toBe(1);
  });

  test('catchUp returns only after what was published before it is applied', async () => {
    const boardId = crypto.randomUUID();
    await getPage(boardId, 32, 0);
    expect(residentPagesForTest(boardId)).toBe(1);
    // Another process's page event, committed just before the barrier.
    const event: Invalidation = { kind: 'page', boardId, s: 32, page: 0 };
    await pool.query('SELECT pg_notify($1, $2)', [
      'digsite_cache',
      JSON.stringify({ origin: 'another-process', event }),
    ]);
    await catchUp();
    expect(residentPagesForTest(boardId)).toBe(0);
  });

  test('a ladder job that fails for good makes the order stale', async () => {
    const { rows } = await pool.query(
      `INSERT INTO boards (org_id, name, open, created_by, image_count)
       VALUES ('org-fail', $1, true, 'tester', 1) RETURNING id`,
      [`fail-${Date.now()}`],
    );
    const boardId = rows[0].id as string;
    const { rows: img } = await pool.query(
      `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, properties)
       VALUES ($1, 0, 'sha-fail', 'x.png', 10, 10, 'tester', '{}') RETURNING id`,
      [boardId],
    );
    const sort = { key: 'uploaded_at', dir: 'desc' } as const;
    await ensureRank(boardId, sort);
    await onJobFailedFinal('ladder', { imageId: img[0].id }, 'bad file');
    const { rows: state } = await pool.query(
      'SELECT stale FROM board_rank_state WHERE board_id = $1',
      [boardId],
    );
    expect(state.map((r) => r.stale)).toEqual([true]);
  });
});
