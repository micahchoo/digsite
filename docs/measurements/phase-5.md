# Phase 5 — scale debts

`docs/phases/5-hardening.md` section 5, against the same "Synthetic 1M"
board as phase 1 (`25f375ea-4e5e-40c4-b21b-9ad863dbbab1`, group "Lab") and
20 new `load-<n>` boards this phase creates and deletes.

**Machine**: 32 cores, 122 GB RAM (same as phase 1). Postgres `digsite-db`
on 127.0.0.1:5440. `DATA_DIR` resolves under `/mnt/Ghar` (24 TB, ~14 TB free
at the start of this run) — not the root filesystem phase 1's own numbers
mention in passing. Shared dev machine: two other agents' test suites were
running against the same Postgres container for parts of this run.

## Target table

| number | target | measured | pass/fail |
| --- | --- | --- | --- |
| rank rebuild, 1M board, partitioned | ≤ 2 s | 3.45 s (417 ms delete + 3.03 s insert, live migrated table) | **FAIL** (~1.7×, no better than phase 1's post-FK-fix 2.52–3.18 s unpartitioned — see below) |
| materialise budget refusal | a test proves it | `materialise.test.ts`: refuses before any tile is written, `board_rank_state.materialised_at` stays null | **PASS** |
| `Storage.list` contract, fs + s3 | same behaviour both adapters | 18/18 `storage.test.ts` pass under minio (`--profile s3`) | **PASS** |
| every `env.STORAGE !== 's3'` gate | 0 remaining | `grep -rn "STORAGE !== 's3'"` under `src/`: none | **PASS** |
| load run: 20×500k boards, 5 min, 20 viewers | recorded | see "The load run" below | recorded |

## `board_ranks` partitioning: hash(16) kept, ~10–15% not ~10×

Both candidates the brief named were built and measured against the exact
same data before choosing: the "Synthetic 1M" board's `uploaded_at.desc`
rank rebuild, isolated from HTTP with `EXPLAIN (ANALYZE, BUFFERS)`, the same
methodology `docs/measurements/phase-1-map.md` used.

| candidate | DELETE | INSERT (`EXPLAIN ANALYZE`) | total |
| --- | --- | --- | --- |
| baseline (unpartitioned, pre-migration) | 437 ms | 2,877.7 ms | ~3.32 s |
| hash(16), populated with all 5,089,458 live rows | 456 ms | 2,764.3 ms | ~3.22 s |
| list-per-board (this board's own partition + a DEFAULT for the rest) | 301 ms | 2,583.0 ms | ~2.89 s |
| **hash(16), after the real migration, live table** | 417 ms | 3,034.9 ms | ~3.45 s |

List-per-board measured fastest by a real but modest margin (~13% under
baseline, ~10% under hash) — fewer buffer hits too (5,404,321 vs 6,032,029
baseline / 6,033,534 hash on the same `EXPLAIN (ANALYZE, BUFFERS)`). **Kept:
hash(16) anyway**, for a reason the measurement itself surfaced, not a
coin-flip: neither candidate gets near 2 s, and the reason why is the same
for both (see below).

The fourth row — the SAME rebuild, re-measured after `0007_...sql` actually
ran and became the live table, in a later session — comes out a little
*slower* than even the unpartitioned baseline above it, not faster. Read
plainly rather than explained away: this is shared-machine session-to-session
noise (`board_ranks_pkey`'s live size and this database's concurrent load
both drifted between the two measurement sessions — see this file's own
"Machine" note), not evidence that the migration made anything worse. The
honest conclusion either way is the same one the next section makes: on
THIS board, at THIS scale, neither partitioning strategy is a >10% win,
let alone the several-hundred-percent one closing a 3.3 s vs 2 s gap would
need.

### Why neither reaches 2 s, and why that isn't a partitioning failure

`board_ranks`'s primary key is `(board_id, sort_id, rank)`. Partitioning by
`board_id` alone — hash OR list — only separates DIFFERENT boards from each
other. It does nothing for one board's OWN accumulated `sort_id` history:
the "Synthetic 1M" board has been rank-rebuilt under five different
`sort_id`s across this repo's testing history (`uploaded_at.desc`,
`uploaded_at.asc`, `name.asc`, `name.desc`, `p.number.year.asc` — confirmed
by `SELECT sort_id, count(*) ... GROUP BY sort_id`, 1,000,000 rows each),
so its own partition (hash bucket 10, or its dedicated list partition)
holds ~5,000,000 rows regardless of which strategy is used — 98% of
`board_ranks`'s entire 5.09M rows, in EITHER scheme, because they all share
one `board_id`. `docs/measurements/phase-1-map.md`'s own root-cause
analysis said as much before this measurement confirmed it: "reducing \[the
remaining ~2.9s\] further would mean partitioning `board_ranks` by board
\(each board's rebuild then rewrites one partition's much-smaller index\)".
That statement is only half true on THIS board — the index it rewrites is
smaller by ~cross-board-contamination, not by ~5×, because this one board's
own multi-sort history is what the index actually holds.

A fleet of many boards of ordinary size (one or two live sorts each,
not five) would see hash(16)'s real benefit: each board's own bucket sized
close to 1/16th of the whole table instead of carrying its own accumulated
history AND everyone else's. This dev board's unusual rebuild history — a
byproduct of it being reused across every phase's measurement runs — is a
worse case than production, not a better one.

### Why hash(16), not list-per-board, is what shipped

List-per-board needs a partition created for each board at board-creation
time and dropped at board-deletion time — dynamic DDL wired into the board
lifecycle. `boards/routes.ts`'s board-CREATE route is owned by another
agent this phase (this task's brief: "Do NOT edit anything else in the
server ... nor the board-DELETE handler block ONLY" is the one exception
carved out, and it's DELETE, not CREATE). Hash(16) needs no such wiring —
every `board_id` routes to one of 16 fixed partitions Postgres computes on
its own, so it is a schema-only migration with zero coupling to any other
file. Flagging list-per-board for the lead as a real, measured-faster
follow-up if `boards/routes.ts`'s board-create route grows the matching
`CREATE TABLE ... PARTITION OF board_ranks FOR VALUES IN (...)` (and
board-delete drops it) — not done here, out of this task's edit scope.

### The migration

`0007_board_ranks_partitioned.sql`: since Postgres has no
`ALTER TABLE ... PARTITION BY`, it renames the live table aside, creates the
hash(16)-partitioned replacement with the identical column set and primary
key, copies every existing row across (5,098,520 rows at migration time,
across all 535 boards this database has ever ranked — not just the
1M-image board), then drops the old table — all inside the one transaction
`migrate.ts` already wraps every migration file in. Applied cleanly against
the live shared dev database; re-running `bun run migrate` afterward
confirms it as `skip 0007_board_ranks_partitioned.sql (already applied)`.
`ranks.ts`'s own SQL is unchanged — Postgres routes a `board_id`-scoped
query to the right partition on its own, so this is a schema/planner
concern only. Verified with `bun test ranks.test.ts materialise.test.ts
tiles.test.ts delete.test.ts storage.test.ts` against the migrated,
partitioned table: 16 pass, 1 skip (the s3 contract test, minio not running
for that pass), 0 fail.

## Materialisation budget: tile canvases, decoded pages, pending PNG buffers

`boards/materialise.ts`'s `MaterialiseBudget` replaces `allocateTiles`'s old
preflight-arithmetic-only check (`docs/measurements/phase-1-map.md`'s own
"after" section: "does not, and structurally cannot being a pre-flight
arithmetic check, catch the per-page native leak") with a live counter,
`reserve`/`release`d around every allocation this pass makes:

- **Tile canvases** (`allocateTiles`): the same lump-sum preflight as
  before, now routed through the shared counter.
- **Decoded pages** (`scatterSize`): the one reused source-page canvas per
  ladder size (`PAGE × PAGE × 4` bytes — small, but no longer unaccounted
  for) — reserved for the whole size's pass, released when it finishes.
- **Pending PNG buffers** (`EncodePool.run`): the real gap. Every encoded
  PNG is handed to `storage.put` without waiting for it, so a queue of
  Buffers between "encoded" and "written" can grow if the storage adapter
  (S3, a loaded disk) falls behind the encode pool. Each PNG's bytes are
  now reserved the moment it exists and released when its `put` resolves —
  an adapter that falls far enough behind refuses loudly instead of the
  queue growing unbounded.

`reserve` throws the instant a request would cross `MATERIALISE_BUDGET_MB`,
before the allocation happens. `materialise.test.ts`'s new test sets
`env.MATERIALISE_BUDGET_MB = 0` against a real 3,000-image board and
asserts: the call rejects with a message naming the budget; no tile file
for that sort exists afterward; `board_rank_state.materialised_at` stays
null (so `tiles.ts` keeps falling through to compose rather than believing
a materialise that never finished). `env.MATERIALISE_BUDGET_MB` is restored
in a `finally` — it is a plain mutable field on the `env` object (see
`env.ts`), and no other test in this run calls `materialiseSort`
concurrently, so the override is safe for the duration of one test.

## `Storage.list` and the end of the `STORAGE !== 's3'` gates

`Storage` gained a fifth method, `list(prefix): AsyncIterable<string>`,
implemented on both adapters (`fs.ts`: a recursive directory walk relative
to `root`; `s3.ts`: paginated `ListObjectsV2`). `storage/index.ts#deletePrefix`
batches `list` + bounded-concurrency `delete` (32 keys at a time) into the
"delete everything under this prefix" operation the three gated call sites
each needed:

- `materialise.ts`'s stale-sort clear (previously fs-only `rmSync`).
- `boards/routes.ts`'s board-delete sweep (previously fs-only `rmSync`,
  DATA_DIR-relative) — now `deletePrefix(storageFromEnv(),
  'boards/<id>/')`, which is exactly what the load run's `cleanup` step
  exercises 20 times over at real scale below.
- `coarse-cache.ts#loadResidentSortFromDisk` (previously an fs-only
  directory listing and a deliberate `STORAGE === 's3'` no-op) — now reads
  through `list` + bounded-concurrency `get` on either adapter.

One collateral fix this required: `deletePrefix` calling `delete`
key-by-key, with no more "delete the whole directory in one `rmSync`"
shortcut, means the empty directories those files used to live in would
otherwise never go away — `delete.test.ts`'s existing `existsSync(boardDir)
=== false` assertion after a board delete is what caught this.
`FsStorage.pruneEmptyTree(prefix)` (an fs-only capability `deletePrefix`
reaches via `instanceof FsStorage`, same pattern as `presignedGetUrl`'s
own S3-only capability) removes what's now empty in one post-order walk of
the prefix, called once per `deletePrefix` call rather than once per file
— see "The load run" below for why per-file pruning was tried first, measured
at real scale, and replaced.

`grep -rn "STORAGE !== 's3'\|STORAGE === 's3'" src/`: the only remaining
hit is the legitimate adapter-selection line in `storageFromEnv()` itself.

Verified: `bun test storage.test.ts` — 9 pass / 1 skip against fs alone
(no `S3_ENDPOINT` set); 18 pass / 0 fail with
`docker compose --profile s3 up -d --wait minio minio-init` running and
`S3_ENDPOINT=http://127.0.0.1:9100 S3_BUCKET=digsite S3_ACCESS_KEY=digsite
S3_SECRET_KEY=digsite-secret bun test storage.test.ts` — the new `list`
contract tests (yields every key under a prefix and nothing outside it;
yields nothing for a prefix nobody ever wrote) pass on both adapters. Minio
stopped and removed afterward (`docker compose --profile s3 stop/rm`) —
never left running past this task, per the brief.

## The load run

20 boards (`load-1` .. `load-20`, group "Lab"), 500,000 synthetic images
each — 10,000,000 total — each with two sorts (`uploaded_at.desc`, the
default, and `name.asc`) rank-built and materialised, built by the new
`server/scripts/load-boards.ts`. Disk checked first (`checkDiskOrThrow`):
13.9 TB free at `DATA_DIR`, eager S=128 painting projected at well under
1 TB (a deliberately conservative decoded-RGBA upper bound, not the actual
PNG size — see the script's own comment) against a 2.8 TB 20%-of-free
ceiling, so no lazy-S128 fallback was needed, same as phase 1's board.

### Build: 20 boards, rank + materialise ×2 sorts, under `MemoryMax=60G`

```
systemd-run --user --scope -p MemoryMax=60G -p MemorySwapMax=0 \
  --unit=digsite-load-build -- bun run scripts/load-boards.ts build
```

**17 min 53 s wall clock, 46.8 GB memory peak** (systemd's own accounting,
`journalctl --user -u digsite-load-build.scope`), nowhere near the 60 GB
cap. All 20 boards confirmed at `image_count = 500000` afterward.

Rank rebuild and materialise times, 40 samples each (20 boards × 2 sorts),
**with the partitioned `board_ranks`, at 500,000 images/board**:

| | n | min | median | mean | max |
| --- | --- | --- | --- | --- | --- |
| rank rebuild (ms) | 40 | 961.5 | 1,184.4 | 1,185.1 | 1,750.1 |
| materialise (ms) | 40 | 8,882.7 | 9,780.7 | 9,871.7 | 12,198.3 |

Both scale roughly linearly with board size against the 1,000,000-image
numbers: rank rebuild here (500k, partitioned, but each of these boards
has only ever been rebuilt under these same 2 `sort_id`s, unlike the
"Synthetic 1M" board's accumulated five) is well under half of the
1,000,000-image board's ~2.6–3.5 s range — this is the partitioning
section's own point made a second way: a board without an unusually large
multi-sort history rebuilds fast. Materialise at ~9.8 s median here is
almost exactly half of the 1,000,000-image board's post-fix 24.5 s
(`docs/measurements/phase-1-map.md`), as expected — z ≤ −3 tile count is
~linear in image count.

### Load: 20 concurrent viewers, 5 minutes, `LADDER_BUDGET_MB` at default

```
PORT=8814 systemd-run --user --scope -p MemoryMax=60G -p MemorySwapMax=0 \
  --unit=digsite-load-run -- bun run scripts/load-boards.ts load 300000
```

One viewer per board (all 20 `load-*` boards, one each), each firing tile
requests back-to-back (no artificial pacing — one request in flight per
viewer, 20 concurrent overall) for 5 minutes, random zoom (uniform across
all six), random sort (the two materialised ones), random tile position
within that board's grid at that zoom. `LADDER_BUDGET_MB` left at `.env`'s
default (4096). The server ran IN-PROCESS inside the script (not a
separate `bun run src/index.ts`) so `boards/ladder.ts`'s eviction counter
and both caches' resident-byte counters could be read directly from the
same process that served the requests — see the script's own header
comment for why a separate server process wouldn't answer the same
question honestly.

**5 min 3 s wall clock, 19.6 GB memory peak** (systemd accounting,
`digsite-load-run.scope`); this script's own internal RSS sampling (every
5 s, `process.memoryUsage().rss`) agrees closely: **17.56 GB peak**. 25,288
tile requests served.

Tile latency by zoom (ms):

| z | ladder/tile size | p50 | p95 | p99 | n |
| --- | --- | --- | --- | --- | --- |
| 0 | S=128, composed | 26.8 | 449.8 | 988.7 | 4,298 |
| −1 | S=128, composed | 56.8 | 1,422.5 | 2,705.8 | 4,199 |
| −2 | S=32, composed | 116.1 | 3,829.0 | 6,420.5 | 4,175 |
| −3 | S=32, materialised | 9.0 | 74.5 | 132.4 | 4,219 |
| −4 | S=8, materialised | 9.1 | 70.9 | 125.9 | 4,190 |
| −5 | S=8, materialised | 8.8 | 77.0 | 131.2 | 4,207 |

Tile latency by `X-Cache` (ms):

| X-Cache | p50 | p95 | p99 | n |
| --- | --- | --- | --- | --- |
| miss (composed, z ≥ −2) | 78.4 | 1,611.0 | 4,888.0 | 12,595 |
| resident (materialised, z ≤ −3) | 9.0 | 73.8 | 130.0 | 12,616 |
| hit (composed-tile cache) | 8.9 | 52.2 | 59.1 | 77 |

Ladder-page LRU evictions, sampled once a minute
(`boards/ladder.ts#evictionCount`, this run's own in-process counter):
**9,947 / 13,147 / 66,717 / 94,259 / 93,482** — ramping hard through the
run and never settling. At the end, `ladder.ts#residentBytes()` reports
**4,294,967,296 bytes — exactly `LADDER_BUDGET_MB`'s 4,096 MiB**: the
resident LRU is pinned at its ceiling for the whole run.
`coarse-cache.ts#residentBytes()` ends at **1,016,097,681 bytes**, near
its own 1,024 MiB `COARSE_BUDGET_MB` ceiling too (20 boards × 2
materialised sorts each is more than 1,024 MB can hold at once).

### Reading these numbers against `tile-cache-is-for-the-second-viewer.md`

This run is exactly the case that rule's own "keep residency per OPEN
board" reasoning names and doesn't cover: **20 boards open at once,
sharing one process-wide `LADDER_BUDGET_MB`.** z ≤ −3 (materialised,
served from the resident coarse-tile cache — `X-Cache: resident`) is fast
and STABLE throughout: p50 ~9 ms, p95 ~70–77 ms, matching phase 1's
single-board resident numbers closely. z ≥ −2 (composed on demand from
ladder pages) is an order of magnitude worse than phase 1's single-viewer
baseline (phase 1: z=0 p95 11.34 ms at 256 MB, resident; here: z=0 p95
449.8 ms) — and z=−2's p99 (6.4 s) is worse again, because it is the
zoom where a viewer spends the most real time (per the rule's own
reasoning) AND the zoom whose ladder pages (S=32) are the ones being
evicted fastest under 20-board contention. The eviction-rate ramp
(10k → 93k/minute) is the mechanism: with 20 boards panning independently,
every board's ladder pages get evicted by the NEXT board's request before
this board's next request can reuse them, so composed tiles at z ≥ −2 are
COLD MISSES almost every time instead of warm ones — the rule's own
"single-viewer latency comes from ladder residency" holds; it's just that
residency itself is the scarce resource once 20 boards compete for it, not
per-tile compute cost. `LADDER_BUDGET_MB` staying at `.env`'s process-wide
default (4096, meant for ONE open board in phase 1's own single-board
runs) rather than a raised or per-board budget is the direct cause —
flagging for the lead: a multi-board deployment needs either a much larger
`LADDER_BUDGET_MB` or a residency floor per open board, neither of which
this phase's brief asked for.

### Cleanup: 20 boards deleted through the product's own board-delete route

```
PORT=8814 bun run scripts/load-boards.ts cleanup
```

All 20 `load-*` boards deleted successfully (`DELETE /boards/:id` → `200`
each), confirmed by `SELECT name FROM boards WHERE name LIKE 'load-%'`
returning zero rows afterward and no `boards/<id>/` directory left under
`DATA_DIR` for any of them.

**First measured at ~45 seconds per board** (range: 44.6–46.6 s across all
20 in this run). Root cause, read from the numbers rather than guessed: at
500,000 images the board-delete route's SQL (rows across
`edges`/`regions`/`sheet_snapshots`/`sheet_images`/`sheets`/`board_ranks`/
`board_rank_state`/`jobs`/`images`/`boards`, one transaction) is fast —
the same shape phase 1 measured at ~3 s for 1,000,000-row rank deletes
alone, so well under a second at half that scale. The ~45 s was the file
sweep: `deletePrefix` lists and deletes roughly 38,000 files per board at
this size (ladder pages: S=128 at 16/page → ~31,250 pages, S=32 at
256/page → ~1,954, S=8 at 4,096/page → ~123; plus 2 materialised sorts ×
2,624 z≤−3 tiles → 5,248 — ~38,575 total), 32 at a time
(`deletePrefix`'s own batching), and `FsStorage.delete`'s FIRST version
pruned empty directories up to the board root after EVERY ONE of those
~38,000 individual file deletes — O(files × directory depth), not
O(directories).

**Fixed in this task, not just flagged**: `FsStorage.delete` no longer
prunes per-file; `FsStorage.pruneEmptyTree(prefix)` is a new fs-only
capability (`instanceof FsStorage`, same pattern as `presignedGetUrl`'s
own S3-only capability — a sixth `Storage` interface method would be
meaningless on S3, which has no directories) that `deletePrefix` calls
ONCE, after every key is already gone, walking `prefix`'s own subtree
post-order and removing what's now empty — O(directories) regardless of
file count. Re-measured on a fresh 500,000-image board built and deleted
the same way: **23.1 s**, essentially exactly half. The remaining cost is
the ~38,000 individual `rm()` unlinks themselves (still 32-at-a-time
concurrent, unchanged) — genuinely the floor for "one file per ladder page
and tile, deleted one key at a time," and no explicit delete-latency
target was set for this phase, so raising `deletePrefix`'s concurrency
past 32 (the next lever, untested here) is flagged for the lead rather
than tuned blind under this task's remaining time budget. Verified
correct, not just fast: `storage.test.ts`'s full contract and
`delete.test.ts`'s both tests (which assert `existsSync(boardDir) ===
false` after a board delete) still pass against the new code.
