---
scope: [server/src/worker/**, server/src/boards/**, server/src/storage/**]
tags: [worker, memory, jobs, cache, process]
priority: high
source: hand-written
---

# server: the worker is disposable, the API is not

The worker runs as a child of the server (`worker/supervisor.ts`,
`WORKER=process`, the default). Image work has leaked native memory four
separate ways (`canvas-holds-its-sources.md`), so the design assumes the
worker WILL die, and makes that cheap:

- **It retires** past `WORKER_RSS_LIMIT_MB` / `WORKER_MAX_JOBS`, after the
  batch that crossed the line, and the supervisor starts a new one at once.
- **It is the OOM victim.** `worker/main.ts` raises its own
  `oom_score_adj` to 800, so a cgroup at its cap kills the worker and never
  the API. Measured 2026-09-23 under `MemoryMax=4G`: a worker killed two
  seconds after start was replaced in 500 ms while the API kept serving.
- **Its jobs are leased** (`0015_job_leases.sql`). A dead worker's jobs come
  back as spent attempts; a job that kills every worker ends `failed`.

## What must stay true

- **A memory budget is per process, so the work it bounds runs one at a
  time.** `MATERIALISE_BUDGET_MB` was sized for one run, while the worker ran
  four units at once; four concurrent materialises OOM-killed a worker. So
  `materialiseSort` runs behind a one-slot semaphore. A new heavy job gets
  the same treatment, or its budget is fiction.
- **Every per-process cache is invalidated through `boards/invalidation.ts`.**
  The API and the worker hold separate copies of ladder pages, composed tiles
  and coarse tiles. A new cache, or a new writer of what one caches, must
  publish, or the API serves old pixels indefinitely.
- **Anything shared on disk is written atomically.** `FsStorage.put` writes
  beside, then renames, so the API never reads a page the worker is halfway
  through writing. (The "Invalid SVG image" failures first blamed on this
  were the canvas library's decoder: `canvas-holds-its-sources.md`.)
- **Locks hold across processes.** `storage/lock.ts` takes a Postgres
  advisory lock after its in-process queue; do not reintroduce a lock that
  holds only in memory.

Verify with `cd server && bun test worker-lease worker-group supervisor
invalidation lock`, then a 20,000-file import (`e2e/src/import-real.ts`)
against a server in `systemd-run --user --scope -p MemoryMax=4G -p
MemorySwapMax=0 -p OOMPolicy=continue`. `OOMPolicy=continue` matters:
systemd's default stops the whole unit on one kill, which Docker does not.
