import { describe, expect, test } from 'bun:test';
// worker/supervisor.ts with real child processes: a worker that retires or
// is killed is replaced, and the queue still drains.
import { createCanvas } from '@napi-rs/canvas';
import { uploadOne } from '../boards/upload.ts';
import { pool } from '../db/pool.ts';
import { superviseWorker } from '../worker/supervisor.ts';

async function makeBoard(name: string): Promise<string> {
  const { rows } = await pool.query(
    'INSERT INTO boards (org_id, name, open, created_by) VALUES ($1,$2,true,$3) RETURNING id',
    [`org-test-${Date.now()}`, name, 'test-user'],
  );
  return rows[0].id;
}

function square(hue: number): Buffer {
  const canvas = createCanvas(16, 16);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
  ctx.fillRect(0, 0, 16, 16);
  return canvas.encodeSync('png');
}

async function until(check: () => Promise<boolean> | boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

async function readyCount(boardId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM images WHERE board_id = $1 AND status = 'ready'`,
    [boardId],
  );
  return rows[0].n;
}

describe('worker supervisor', () => {
  test('a worker that retires is replaced and the queue drains', async () => {
    const boardId = await makeBoard(`supervise-${Date.now()}`);
    // One batch per life, and one batch claims at most 16 jobs at
    // concurrency 1 (worker/jobs.ts#GROUP): twenty images need two lives.
    for (let i = 0; i < 20; i++) {
      await uploadOne(boardId, 'tester', `${i}.png`, square(i * 18));
    }
    const worker = superviseWorker({
      ...process.env,
      WORKER_MAX_JOBS: '1',
      WORKER_CONCURRENCY: '1',
    });
    try {
      expect(
        await until(async () => (await readyCount(boardId)) === 20, 30_000),
      ).toBe(true);
      // The last worker retires only after its batch ends, which can be a
      // moment after the last image is ready: wait for its exit rather than
      // assume it (roadmap C8: 2 failures in 100 runs, both this).
      expect(await until(() => worker.exits() >= 2, 10_000)).toBe(true);
      expect(worker.crashes()).toBe(0);
    } finally {
      await worker.stop();
    }
  }, 40_000);

  test('a killed worker is restarted', async () => {
    const worker = superviseWorker();
    try {
      expect(await until(() => worker.pid() !== null, 5_000)).toBe(true);
      const first = worker.pid() as number;
      process.kill(first, 'SIGKILL');
      expect(
        await until(
          () => worker.pid() !== null && worker.pid() !== first,
          10_000,
        ),
      ).toBe(true);
      expect(worker.exits()).toBe(1);
      expect(worker.crashes()).toBe(1);
    } finally {
      await worker.stop();
    }
  }, 20_000);
});
