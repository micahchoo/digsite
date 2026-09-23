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
import {
  type ClaimedJob,
  DecodeError,
  GROUP,
  type Unit,
  onJobFailedFinal,
  planUnits,
} from './jobs.ts';
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

// A claimed job holds a lease (0015_job_leases.sql), renewed every third of
// it while the job runs. A worker that dies mid-job stops renewing, and the
// next poll anywhere hands the job back as a spent attempt. Longer than any
// single step inside a job, so a live but busy event loop never loses one.
const LEASE_MS = 60_000;
const ABANDONED = 'the worker stopped while running this job (lease expired)';

/** Returns running jobs whose worker died to the queue. The dead attempt
 * counts: a job that kills its worker every time (a file that exhausts
 * memory) must end `failed`, not take the next worker down with it. */
async function reapAbandoned(): Promise<void> {
  const { rows } = await pool.query(
    `UPDATE jobs SET
       attempts = attempts + 1,
       state = CASE WHEN attempts + 1 >= $1 THEN 'failed' ELSE 'pending' END,
       run_after = now(), lease_until = NULL, last_error = $2
     WHERE state = 'running' AND lease_until < now()
     RETURNING kind, payload, state`,
    [MAX_ATTEMPTS_BACKOFF, ABANDONED],
  );
  for (const row of rows) {
    if (row.state === 'failed')
      await onJobFailedFinal(row.kind, row.payload, ABANDONED);
  }
}

function renewLeases(ids: number[]): () => void {
  const timer = setInterval(() => {
    pool
      .query(
        `UPDATE jobs SET lease_until = now() + ($2 || ' milliseconds')::interval
         WHERE id = ANY($1) AND state = 'running'`,
        [ids, String(LEASE_MS)],
      )
      .catch((error) => console.error('[worker] lease renewal failed', error));
  }, LEASE_MS / 3);
  return () => clearInterval(timer);
}

async function claim(concurrency: number): Promise<ClaimedJob[]> {
  const { rows } = await pool.query(
    `UPDATE jobs SET state = 'running',
       lease_until = now() + ($2 || ' milliseconds')::interval
     WHERE id IN (
       SELECT id FROM jobs
       WHERE state = 'pending' AND run_after <= now()
       ORDER BY run_after ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, kind, payload, attempts`,
    [concurrency, String(LEASE_MS)],
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
    `UPDATE jobs SET state = 'pending', attempts = $2, lease_until = NULL,
       run_after = now() + ($3 || ' milliseconds')::interval,
       last_error = $4
     WHERE id = $1`,
    [job.id, attempts, String(delayMs), reason],
  );
}

async function settle(job: ClaimedJob, error: unknown): Promise<void> {
  if (error === null) {
    await finish(job.id);
    return;
  }
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`[worker] job ${job.id} (${job.kind}) failed:`, error);
  await fail(job, reason, error instanceof DecodeError);
}

/** Runs units `concurrency` at a time. A unit is a page's worth of ladder
 * jobs or one other job (jobs.ts#planUnits). */
async function runUnits(units: Unit[], concurrency: number): Promise<void> {
  const queue = [...units];
  const lane = async () => {
    for (let unit = queue.shift(); unit; unit = queue.shift()) {
      const outcomes = await unit.run();
      await Promise.all(
        unit.jobs.map((job, i) => settle(job, outcomes[i] ?? null)),
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, units.length) }, lane),
  );
}

/** Claims up to `concurrency` units' worth of due jobs and runs them once.
 * Returns how many jobs were claimed, so `drain()` knows when to stop — a
 * backed-off job's run_after is in the future, so it isn't "due" and
 * `drain()` correctly stops without waiting for it. */
export async function pollOnce(
  concurrency: number = env.WORKER_CONCURRENCY,
): Promise<number> {
  await reapAbandoned();
  const jobs = await claim(concurrency * GROUP);
  if (jobs.length === 0) return 0;
  const stopRenewing = renewLeases(jobs.map((job) => job.id));
  try {
    await runUnits(await planUnits(jobs), concurrency);
  } finally {
    stopRenewing();
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

/** `afterBatch` sees each batch's job count once it has finished; a worker
 * process uses it to decide when to retire (worker/main.ts). */
export function startWorker(
  concurrency: number = env.WORKER_CONCURRENCY,
  afterBatch: (jobs: number) => void = () => {},
): void {
  if (stopLoop) return;
  stopLoop = workerLoop(
    async () => {
      const jobs = await pollOnce(concurrency);
      afterBatch(jobs);
      return jobs;
    },
    (error) => console.error('[worker] poll failed', error),
    POLL_INTERVAL_MS,
  );
}

export function stopWorker(): void {
  stopLoop?.();
  stopLoop = null;
}
