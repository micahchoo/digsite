// `bun run worker` — the worker alone, no HTTP server. The server spawns
// this under worker/supervisor.ts when WORKER=process (the default); it can
// also run by hand beside a server started with WORKER=off.
//
// Image work leaks native memory in ways found one at a time
// (.claude/rules/canvas-holds-its-sources.md), so this process retires on
// purpose: after the batch that takes it past WORKER_RSS_LIMIT_MB or
// WORKER_MAX_JOBS, it stops claiming and exits 0. Leased jobs mean a hard
// kill loses nothing either (0015_job_leases.sql).
import { writeFileSync } from 'node:fs';
import '../env.ts';
import { listenForInvalidation } from '../boards/invalidation.ts';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { startWorker, stopWorker } from './index.ts';

let jobs = 0;
let retiring = false;

async function retire(reason: string): Promise<void> {
  if (retiring) return;
  retiring = true;
  stopWorker();
  console.log(`[worker] retiring after ${jobs} jobs: ${reason}`);
  await pool.end().catch(() => {});
  process.exit(0);
}

function afterBatch(count: number): void {
  jobs += count;
  const rssMb = process.memoryUsage().rss / 1048576;
  if (rssMb > env.WORKER_RSS_LIMIT_MB)
    retire(`RSS ${Math.round(rssMb)} MB > ${env.WORKER_RSS_LIMIT_MB} MB`);
  else if (jobs >= env.WORKER_MAX_JOBS)
    retire(`${jobs} jobs >= ${env.WORKER_MAX_JOBS}`);
}

// When memory runs out, the kernel kills the process with the highest OOM
// score. Make that this one: the supervisor replaces a worker in a second,
// and leases return its jobs, but nothing replaces the API. Linux lets a
// process raise its own score without privilege; elsewhere, nothing to do.
try {
  writeFileSync('/proc/self/oom_score_adj', '800');
} catch {
  // not Linux, or /proc is not writable here
}

// A supervised worker must not outlive its server: nothing would restart
// it, and nothing would stop it either.
const parent = process.ppid;
if (process.env.DIGSITE_SUPERVISED === '1') {
  setInterval(() => {
    if (process.ppid !== parent) retire('the server exited');
  }, 1_000).unref();
}
process.on('SIGTERM', () => retire('SIGTERM'));

console.log(
  `digsite worker ${process.pid} starting (retires past ${env.WORKER_RSS_LIMIT_MB} MB or ${env.WORKER_MAX_JOBS} jobs)`,
);
listenForInvalidation();
startWorker(env.WORKER_CONCURRENCY, afterBatch);
