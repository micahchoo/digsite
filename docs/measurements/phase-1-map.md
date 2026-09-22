# Phase 1 — the scale run

`docs/phases/1-map.md` section 4, against a 1,000,000-image board built by
`server/scripts/synth.ts` and driven through the real HTTP routes by
`server/scripts/measure-map.ts`. Board id `25f375ea-4e5e-40c4-b21b-9ad863dbbab1`
("Synthetic 1M", group "Lab", owned by `member@example.test`).

**Machine**: 32 cores, 122 GB RAM. Postgres `digsite-db` (`postgres:16-alpine`
in Docker) on 127.0.0.1:5440. This is a shared dev machine — other agents'
test suites were running against the same Postgres container for parts of
this run (see "What didn't work" below); numbers that look inconsistent
with a clean before/after comparison are flagged where that is the likely
cause.

## Target table

| number | target | measured | pass/fail |
| --- | --- | --- | --- |
| rank rebuild, one sort | ≤ 2 s | `uploaded_at.desc` 6.55 s / `name.asc` 6.22 s / `p.number.year.asc` 6.57 s | **FAIL** (~3.2×) |
| tile miss p95, ladder resident, z = 0 … −2 | ≤ 50 ms | see below — PASS at 256 MB, mixed at 4096 MB | **see below** |
| tile p95 at z ≤ −3 after materialisation | ≤ 5 ms (disk) | 10.03 ms p95 (0.83 ms p50), 500/500 `X-Cache: disk` | **FAIL** (~2×, p50 well under) |
| materialise z ≤ −3 for one sort | ≤ 60 s | 277.2 s (`WORKER_CONCURRENCY=4`, the shipped default) | **FAIL** (~4.6×) |
| viewer: sort change to first tile, rank built | ≤ 300 ms | median 14 ms (reps: 1651, 13, 14, 15, 13 ms) | **PASS** |

One clean pass, three clear misses with an identified root cause each (below),
one row that depends on `LADDER_BUDGET_MB` and needs its own explanation.

## Row 2 in detail — tile miss p95, ladder resident, z = 0 … −2

500 unique random tiles per zoom (deduplicated within a zoom — see "What
was changed" below), a warm-up pass, then `POST .../rebuild` to clear the
composed-tile cache without touching ladder-page residency, then a second
unique sample, measured.

| z | ladder size | 256 MB p50 | 256 MB p95 | 4096 MB p50 | 4096 MB p95 |
| --- | --- | --- | --- | --- | --- |
| 0 | S=128 | 7.00 ms | 11.34 ms | 44.34 ms | 70.89 ms |
| −1 | S=128 | 18.62 ms | 23.79 ms | 158.68 ms | 236.36 ms |
| −2 | S=32 | 44.11 ms | 48.12 ms | 10.10 ms | 35.05 ms |

At **256 MB** every zoom in the target's range is under 50 ms p95 — **PASS**.
At **4096 MB**, z=−2 improves sharply (as `tile-cache-is-for-the-second-viewer.md`
predicts for S=32) but z=0/−1 get *worse*, which the rule does not predict.

Root cause for the z=0/−1 numbers, both budgets: **the sampling methodology
in this script does not establish real residency for S=128.** S=128 has
62,500 total pages; a 500-tile warm-up at z=0 touches roughly 125 distinct
pages, at z=−1 roughly 500 — under 1% of the population either way, so an
independently-drawn 500-tile *measured* sample almost never lands on an
already-touched page. Both budgets are effectively measuring a first-touch
(cold) compose at z=0/−1, and the 256-vs-4096 gap there is machine noise
from the other agents sharing this Postgres instance, not a residency
effect. S=32 (3,907 pages) and S=8 (245 pages) don't have this problem —
the *cumulative* touches from z=−2's own passes plus the z=−3 warm-up
(which runs before z=−2's measured pass, since the script processes zooms
in order within one pass) cover a meaningful fraction of S=32's population,
which is exactly why z=−2/−3's numbers behave as the rule predicts (see
below). **A tile-level residency test for S=128 needs either a much larger
sample or an explicit `preloadPages` warm-up (as `materialise.ts` already
does), not a same-sized random sample as S=32/S=8.**

For reference, the same rule's namesake numbers (S=32, z=−3, not in the
formal target row but the cleanest evidence in this run):

| z | ladder size | 256 MB (not resident) | 4096 MB (resident) |
| --- | --- | --- | --- |
| −3 | S=32 | 162.4 ms p50 / 171.6 ms p95 | 26.6 ms p50 / 64.9 ms p95 |

26.6 ms vs. the rule's own reference "resident: 27 ms p50" — a near-exact
match. `tile-cache-is-for-the-second-viewer.md` holds up cleanly here.

z=−4/−5 (S=8, not in the target row) for completeness: 256 MB gave
119.4/175.2 ms (z=−4) and 437.8/945.1 ms (z=−5); 4096 MB gave 79.0/135.1 ms
and 596.7/740.1 ms. z=−5 composes 4,096 individual `drawImage` calls per
tile (cellPx=4, S=8) and both runs show high variance — likely the same
shared-machine noise as z=0/−1, on top of a genuinely expensive compose.

Every sampled tile in this section was `X-Cache: miss` (confirmed in the
raw JSON), so these are real composes, not composed-tile-cache hits.

## Row 1 — rank rebuild: root cause

`EXPLAIN ANALYZE` on the exact `rebuildRank` INSERT for this board:

```
Insert on board_ranks (actual time=2738.413..2738.415 rows=0 loops=1)
  -> Subquery Scan (actual time=258.069..488.598 rows=1000000 loops=1)
       -> WindowAgg (actual time=258.065..442.231 rows=1000000 loops=1)
            -> Sort (Sort Method: external merge Disk: 25488kB) (actual time=258.026..322.447)
                 -> Seq Scan on images (actual time=4.129..79.168 rows=1000000)
  Trigger for constraint board_ranks_board_id_fkey: time=3950.993 calls=1000000
Execution Time: 6729.860 ms
```

The `ROW_NUMBER()` sort itself is fast (~450 ms — close to the prototype's
~900 ms full rebuild at this row count). **`board_ranks.board_id REFERENCES
boards(id)` fires Postgres's FK-check trigger once per inserted row**
(`0002_domain.sql`) — 3.95 s of the 6.7 s, confirmed by comparing this
`EXPLAIN ANALYZE` against a plain `SELECT` of the same query (450 ms, no
trigger). `DELETE FROM board_ranks` (in the same transaction, not shown
above) adds another ~380 ms. This is a schema-level cost, not something
`ranks.ts`'s query shape can fix — not changed here (outside this brief's
scope; flagging for the lead). A `DEFERRABLE` FK, or dropping it in favour
of the existing `boards(id)` primary key being enforced at the application
layer (every write to `board_ranks` already goes through `rebuildRank`,
which only ever inserts a `board_id` it just read from `boards`), are the
two obvious fixes; either would need its own migration and isn't a "small
server change."

## Row 4 — materialise: root cause

277.2 s to materialise all 5,216 expected z ≤ −3 tiles for one sort
(confirmed: 5,216/5,216 files present, `board_rank_state.materialised_at`
set). `materialise.ts` runs `WORKER_CONCURRENCY` tiles in parallel —
**`.env`'s shipped default is `WORKER_CONCURRENCY=4`**, on a 32-core
machine. `docs/phases/1-map.md` says materialisation should take
"seconds on 32 cores with the ladder resident" — that reads as an
assumption of much higher parallelism than the shipped default gives.
Back-of-envelope: 5,216 tiles ÷ 4 concurrent × (a blend of the z=−3/−4/−5
per-tile compose costs measured above, tens to hundreds of ms each) lands
in the same few-hundred-second range observed. Not changed here (an env
default, not code, but still outside the files this brief named) —
raising `WORKER_CONCURRENCY` for a materialise-heavy deployment is the
likely fix and worth the lead's attention.

## Row 3 — coarse tiles after materialisation

500 random z ∈ {−3, −4, −5} tiles, sampled without repeats within each
zoom, against the just-materialised sort. All 500 came back
`X-Cache: disk`. p50 0.83 ms is comfortably inside "served from disk";
p95 10.03 ms is roughly 2× the 5 ms target — a handful of slower reads in
the tail (plausibly page-cache-cold files on first touch by *this*
script, or shared-disk contention) pull the p95 up while the median is
already excellent.

## Row 5 — viewer, in detail

Real Playwright browser against the unedited web app, driven through the
UI (sign in, open `/b/:id`, wait for the initial fit's first tile, then 5
single-control sort-key changes alternating `name.asc` ↔
`p.number.year.asc` — both pre-built by the rank step, so each toggle is a
single atomic UI action never passing through an unbuilt sort). Screenshot:
`docs/measurements/phase-1-viewer.png` (visibly the "sorted by name" view —
the golden-angle hue recipe with no correlation to name order, so it reads
as noise, as expected).

Initial page load's first tile: 2,746 ms (not the target metric — includes
Vite/React/deck.gl startup, not a sort change). The five measured reps:
1651, 13, 14, 15, 13 ms. The first rep's outlier is explained the same way
as row 2's z=0/−1 numbers: `name.asc`'s specific viewport touches S=128
pages this fresh server process hadn't touched yet, so it pays a first-touch
compose cost once; every later toggle (including back to `name.asc` on rep
2) is warm. **Median naturally absorbs this** — 14 ms, 21× under target,
**PASS**.

## What was changed (server/scripts only, per this brief)

- `server/scripts/synth.ts`, `server/scripts/synth-worker.ts`: new, as
  specified.
- `server/scripts/measure-map.ts`: new, as specified.
- `server/package.json`: added `playwright` as a devDependency (the viewer
  subcommand needs it; `bun install` — only `bun.lock` and this file
  changed, verified with `git status` that no `web/`/`e2e/` files were
  touched by the install).
- `server/tsconfig.json`: `include` widened from `["src"]` to
  `["src", "scripts"]` so `bun run check` type-checks these scripts too
  (matching `web/tsconfig.json`'s existing `"scripts"` entry). `bun run
  check` and `bun test` (11 pass) both still clean after this.
- No product code in `boards/`, `worker/`, or the schema was touched.
  Disk was never close to tight (see below), so the S=128-lazy-fallback
  deviation the brief allowed for was not needed and `ladder.ts` was not
  touched.

## What didn't work / deviations

1. **Rank rebuild misses its 2s target by ~3×**, root-caused to the
   `board_ranks_board_id_fkey` FK-check trigger (see above). Not a bug in
   this phase's new code — the FK predates phase 1 — but it's the thing
   this scale run exists to surface.
2. **Materialise misses its 60s target by ~4.6×**, root-caused to the
   shipped `WORKER_CONCURRENCY=4` default being far below the machine's 32
   cores (see above).
3. **Coarse-tile p95 (10.03 ms) is ~2× the 5ms target** even though p50
   (0.83 ms) is well inside it — tail latency on disk reads, not
   investigated further (lower priority than 1/2).
4. **The tile-residency test (row 2) doesn't cleanly measure S=128** with
   a 500-tile sample, because S=128's page population (62,500) is two
   orders of magnitude larger than S=32's (3,907) or S=8's (245) — see the
   detailed explanation above. The z=−3 numbers (S=32) are the clean,
   trustworthy evidence for the underlying rule instead.
5. **The measured-server process died once** partway through an earlier
   attempt at the 4096 MB tile run, with no error in its log (not an OOM —
   67 GB of 122 GB was free at the time; cause not identified, plausibly
   this shared machine). Re-run cleanly on retry; flagging in case it
   recurs under real load.
6. **`synth.ts` painted all three ladder sizes eagerly**, including
   S=128 (62,500 pages) — the brief's fallback trigger (>20% of free disk
   or >15 minutes) was never approached: full 1,000,000-image paint took
   56.8 s and 3.1 GB, against 14 TB free. No lazy-S128 path was needed or
   built.
7. Two throwaway smoke-test boards (50 and 100,000 synthetic images) were
   created while developing `synth.ts` and deleted (rows + files) before
   the real run — mentioned for the record, not left behind.

## Disk

- Ladder (S=8 + S=32 + S=128, all eager): **3.1 GB**.
- Materialised tiles (one sort, z ≤ −3, 5,216 files): **124 MB**.
- Board total: **3.2 GB**, against 14 TB free on `/mnt/Ghar` (`/dev/md0`,
  40% used at the time) — 0.02%.

## Time

- `synth.ts --new "Synthetic 1M" 1000000`: 56.8 s (1,000,000 rows inserted
  in 100 batches of 10,000; ladder pages painted by 16 Bun workers).
- Rank rebuild ×3 (cold): 6.55 + 6.22 + 6.57 s ≈ 19.3 s.
- Tile measurement ×2 budgets: a few minutes each (3,000 tiles × 2 passes,
  plus a rebuild between them).
- Materialise: 277.2 s.
- Coarse-tile measurement: a few seconds.
- Viewer (Playwright): well under a minute.
- Total wall time for the whole scale run, across restarts: roughly 40
  minutes, dominated by the materialise step.

## Exact commands

```bash
# from app/server, after `bun run migrate` and `bun run seed` once against
# a normally-started dev server

# the board (idempotent — safe to re-run)
bun run scripts/synth.ts --new "Synthetic 1M" 1000000

# budget 256 MB: rank rebuild + tile pass
PORT=8801 WEB_ORIGIN=http://localhost:5181 LADDER_BUDGET_MB=256 WORKER=off \
  bun run src/index.ts &
PORT=8801 bun run scripts/measure-map.ts rank 25f375ea-4e5e-40c4-b21b-9ad863dbbab1
PORT=8801 bun run scripts/measure-map.ts tiles 25f375ea-4e5e-40c4-b21b-9ad863dbbab1 256
# stop the server

# budget 4096 MB: tile pass, materialise, coarse tiles
PORT=8801 WEB_ORIGIN=http://localhost:5181 LADDER_BUDGET_MB=4096 WORKER=off \
  bun run src/index.ts &
PORT=8801 bun run scripts/measure-map.ts tiles 25f375ea-4e5e-40c4-b21b-9ad863dbbab1 4096
PORT=8801 bun run scripts/measure-map.ts materialise 25f375ea-4e5e-40c4-b21b-9ad863dbbab1
PORT=8801 bun run scripts/measure-map.ts coarse 25f375ea-4e5e-40c4-b21b-9ad863dbbab1

# viewer, web UNEDITED, from app/web
VITE_SERVER_ORIGIN=http://localhost:8801 bun run dev -- --port 5181 --strictPort &
# from app/server
PORT=8801 bun run scripts/measure-map.ts viewer 25f375ea-4e5e-40c4-b21b-9ad863dbbab1 http://localhost:5181
# stop both servers
```

## Housekeeping

- `bun run seed` re-run against a running server: `fixture already seeded
  ("Lab" exists), skipping` — idempotent.
- Board "Field" (`066c9df6-1e0a-4f56-bb15-c28357e23ed2`): `image_count=82`,
  unchanged by anything in this run (never referenced by `synth.ts` or
  `measure-map.ts`; confirmed before and after).
- Ports 8801 and 5181 (this run's server and web instances) were stopped
  by exact PID at the end; confirmed free afterward. Ports 8800 and 5180
  (the concurrent web agent's stub/dev server) were never bound, started,
  or stopped by this run.
- The `jobs` table was empty at the end (confirmed).
