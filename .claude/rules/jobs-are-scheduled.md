---
scope: [server/src/worker/**, server/src/boards/**, server/src/meaning/**]
tags: [worker, jobs, queue]
priority: high
source: hand-written
checks:
  - forbid: 'INSERT INTO jobs'
    in: server/src/**
    except: [server/src/worker/schedule.ts, server/src/test/**, server/src/db/migrations/**]
    message: queue work only through worker/schedule.ts#schedule
---

# server: every job is queued through `worker/schedule.ts`

A kind declares in `schedule.ts#KINDS` whether it coalesces, one pending
job per board, and how long a burst settles. `worker/jobs.ts#RUNNERS` is
a `Record<JobKind, …>`, so a new kind without a runner does not compile.

## What must stay true

- **A read never postpones work.** A request path that only wants a job
  to exist uses `schedule(kind, payload, 'soon')`. `settle` belongs to
  the writes whose burst it waits out. Before this module, GET
  /boards/:id used the settling upsert, and a board polled every 3 s was
  never arranged (walk claim 16, 2026-09-23).
- **A coalescing kind has its partial unique index**
  (`WHERE kind = '<kind>' AND state = 'pending'`) in a migration, named
  in the comment beside it in `KINDS`. ON CONFLICT needs the predicate
  written literally, so the kind is interpolated, and only ever from
  `KINDS`.

Verify with `cd server && bun test schedule arrange-on-read` and
`bun run lint:seams` at the root.
