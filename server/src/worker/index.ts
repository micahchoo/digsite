import { pool } from '../db/pool.ts';
// The job queue's mechanics — claim, retry, fail — knowing nothing about
// what a job means (that's jobs.ts#runJob). Polls `jobs` with `SELECT ...
// FOR UPDATE SKIP LOCKED`, concurrency from WORKER_CONCURRENCY. Busy batches
// run back-to-back; only an empty queue sleeps for 500ms.
// (docs/phases/1-map.md "Upload as a worker"). `index.ts` calls
// `startWorker()` unless `WORKER=off`; `bun run worker` (worker/main.ts)
// runs it alone. Tests use `drain()` instead of the interval loop, so a
// test never leaks a timer.
import { env } from '../env.ts';
import { DecodeError, onJobFailedFinal, runJob } from './jobs.ts';
import { workerLoop } from './loop.ts';

const POLL_INTERVAL_MS = 500;

// Phase 5 section 4 (docs/phases/5-hardening.md "Operability", the worker
// bullet): two failure shapes. A DecodeError is deterministic — the same
// bytes fail the same way every time (jobs.ts's own comment on
// DecodeError) — so it keeps the pre-phase-5 behaviour: three attempts,
// no delay between them, straight to `failed`. Anything else (storage
// unreachable, a transient error a retry might actually fix) gets
// exponential backoff — 1s, 10s, 60s between the three retries — before
// landing in `failed` on the fourth attempt.
const MAX_ATTEMPTS_DECODE = 3;
const MAX_ATTEMPTS_BACKOFF = 4;
const BACKOFF_MS = [1_000, 10_000, 60_000];

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

/** `last_error` is written on every attempt, not only the final one —
 * GET /boards/:id/jobs (boards/routes.ts) reads it for `state=failed`, and
 * a mid-retry job carrying its most recent reason costs nothing extra to
 * keep. */
async function fail(
  job: ClaimedJob,
  reason: string,
  isDecodeError: boolean,
): Promise<void> {
  const attempts = job.attempts + 1;
  const maxAttempts = isDecodeError
    ? MAX_ATTEMPTS_DECODE
    : MAX_ATTEMPTS_BACKOFF;
  if (attempts >= maxAttempts) {
    await pool.query(
      'UPDATE jobs SET state = $2, attempts = $3, last_error = $4 WHERE id = $1',
      [job.id, 'failed', attempts, reason],
    );
    await onJobFailedFinal(job.kind, job.payload, reason);
    return;
  }
  const delayMs = isDecodeError ? 0 : (BACKOFF_MS[attempts - 1] ?? 60_000);
  await pool.query(
    `UPDATE jobs SET state = 'pending', attempts = $2,
       run_after = now() + ($3 || ' milliseconds')::interval,
       last_error = $4
     WHERE id = $1`,
    [job.id, attempts, String(delayMs), reason],
  );
}

/** Claims and runs up to `concurrency` due jobs once. Returns how many were
 * claimed, so `drain()` knows when to stop — a backed-off job's run_after
 * is in the future, so it isn't "due" and `drain()` correctly stops
 * without waiting for it (see this function's own `claim()`, which only
 * ever selects `run_after <= now()`). */
export async function pollOnce(
  concurrency: number = env.WORKER_CONCURRENCY,
): Promise<number> {
  const jobs = await claim(concurrency);
  const results = await Promise.allSettled(
    jobs.map(async (job) => {
      try {
        await runJob(job.kind, job.payload);
        await finish(job.id);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[worker] job ${job.id} (${job.kind}) failed:`, err);
        await fail(job, reason, err instanceof DecodeError);
      }
    }),
  );
  // A failed retry-state write must not release the batch while another
  // image is still decoding. Keep concurrency bounded on error paths too.
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
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

let stopLoop: (() => void) | null = null;

export function startWorker(
  concurrency: number = env.WORKER_CONCURRENCY,
): void {
  if (stopLoop) return;
  stopLoop = workerLoop(
    () => pollOnce(concurrency),
    (error) => console.error('[worker] poll failed', error),
    POLL_INTERVAL_MS,
  );
}

export function stopWorker(): void {
  stopLoop?.();
  stopLoop = null;
}
