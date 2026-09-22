import { pool } from '../db/pool.ts';
// The job queue's mechanics — claim, retry, fail — knowing nothing about
// what a job means (that's jobs.ts#runJob). Polls `jobs` with `SELECT ...
// FOR UPDATE SKIP LOCKED` every 500ms, concurrency from WORKER_CONCURRENCY
// (docs/phases/1-map.md "Upload as a worker"). `index.ts` calls
// `startWorker()` unless `WORKER=off`; `bun run worker` (worker/main.ts)
// runs it alone. Tests use `drain()` instead of the interval loop, so a
// test never leaks a timer.
import { env } from '../env.ts';
import { onJobFailedFinal, runJob } from './jobs.ts';

const POLL_INTERVAL_MS = 500;
const MAX_ATTEMPTS = 3;

type ClaimedJob = {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
};

async function claim(concurrency: number): Promise<ClaimedJob[]> {
  const { rows } = await pool.query(
    `UPDATE jobs SET state = 'running'
     WHERE id IN (
       SELECT id FROM jobs
       WHERE state = 'pending' AND run_after <= now()
       ORDER BY run_after ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, kind, payload, attempts`,
    [concurrency],
  );
  return rows;
}

async function finish(id: number): Promise<void> {
  await pool.query('DELETE FROM jobs WHERE id = $1', [id]);
}

// No backoff: a ladder job's failures are deterministic (a bad decode fails
// the same way every time), so a delay only slows the test suite and the
// worker down without buying reliability. Revisit if a job kind with
// transient failures shows up.
async function fail(job: ClaimedJob, reason: string): Promise<void> {
  const attempts = job.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await pool.query(
      'UPDATE jobs SET state = $2, attempts = $3 WHERE id = $1',
      [job.id, 'failed', attempts],
    );
    await onJobFailedFinal(job.kind, job.payload, reason);
    return;
  }
  await pool.query(
    `UPDATE jobs SET state = 'pending', attempts = $2, run_after = now() WHERE id = $1`,
    [job.id, attempts],
  );
}

/** Claims and runs up to `concurrency` due jobs once. Returns how many were
 * claimed, so `drain()` knows when to stop. */
export async function pollOnce(
  concurrency: number = env.WORKER_CONCURRENCY,
): Promise<number> {
  const jobs = await claim(concurrency);
  await Promise.all(
    jobs.map(async (job) => {
      try {
        await runJob(job.kind, job.payload);
        await finish(job.id);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[worker] job ${job.id} (${job.kind}) failed:`, err);
        await fail(job, reason);
      }
    }),
  );
  return jobs.length;
}

/** Runs pollOnce until the queue has nothing due — "running the worker
 * once" for tests and one-off scripts, without starting the interval
 * loop. */
export async function drain(
  concurrency: number = env.WORKER_CONCURRENCY,
): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await pollOnce(concurrency);
    total += n;
    if (n === 0) return total;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startWorker(
  concurrency: number = env.WORKER_CONCURRENCY,
): void {
  if (timer) return;
  timer = setInterval(() => {
    pollOnce(concurrency).catch((err) =>
      console.error('[worker] poll failed', err),
    );
  }, POLL_INTERVAL_MS);
}

export function stopWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
