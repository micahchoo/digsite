---
scope: [server/src/boards/tiles.ts, server/src/boards/ladder.ts, server/src/boards/materialise.ts, server/src/boards/coarse-cache.ts, server/src/boards/routes.ts, server/src/worker/jobs.ts, server/src/worker/tile-encode-worker.ts, server/src/util/semaphore.ts, server/src/seed.ts]
tags: [board, tiles, cache, performance]
priority: medium
source: hand-written
checks:
  - require: "'X-Cache'"
    in: server/src/boards/routes.ts
    message: tile responses must carry X-Cache
  - require: "'Server-Timing'"
    in: server/src/boards/routes.ts
    message: tile responses must carry Server-Timing
---

# tiles: single-viewer latency comes from ladder residency, not the tile cache

Measured 2026-09-21 on a million-image board
(`../prototype/board/RESULTS.md`, `server/RESULTS.md` there): one viewer
panning for a minute hits the composed-tile cache about 4 % of the time,
at a 256 MB budget and at 4.5 GB alike. The budget did not change how
often a tile was a repeat. It changed how fast a MISS was: ladder pages
resident, a miss composed in 27 ms p50; not resident, 238 ms.

Why: rank order is unrelated to slot order by design, so one coarse tile
touches nearly every ladder page of its size. At S=32 a million images
is 3,907 pages, ~3.9 GB decoded, and z = −3 … −2, where a session spends
most of its time, stays cold under any budget that does not hold them.

## So

- **Tune `ladder.ts` for the first viewer.** Pages are resident per open
  board under `LADDER_BUDGET_MB`, LRU across boards. Tens of millions of
  images in total means residency is per OPEN board, never everything.
- **Keep the composed-tile cache for the second viewer.** It is small
  (64 MB), keyed by URL, dropped for a board when its ranks go stale. Do
  not grow it to fix a slow first pan; measure the ladder instead.
- **`X-Cache` and `Server-Timing` stay on every tile response.** They are
  how the number above was measured and how the next one will be.

## Built: materialising coarse levels is a SCATTER, not ladder residency

`materialise.ts` decodes each ladder page exactly ONCE and draws its slots
into whatever tiles they land in — one query for the sort's ranks, not one
`slotsForTile` per tile. Measured 2026-09-22: the old per-tile GATHER took
277 s on the million-image board; the scatter took 24.5 s. `ladder.ts`'s
resident LRU is untouched here on purpose — a scatter visits every page
once, so caching it would only evict a live viewer's pan.

**Reuse the page-sized source canvas across the whole pass; never allocate
one per page.** `@napi-rs/canvas`'s native buffers aren't visible to V8's
GC heuristics, so a fresh `createCanvas` per loop iteration is never
collected in time: one per page OOM-killed the process (30 GB, under 6 s),
reproduced with no DB or real files in under 2 s. One reused canvas
(`scatterSize`'s `pageCanvas`) fixed it — the 5,216 *destination* tiles
don't need this, being a fixed count regardless of page count.

## Coarse tiles are resident too, once materialised

A materialised sort's z ≤ −3 files (~124 MB per sort at 1,000,000 images)
live in `coarse-cache.ts`: `Map<sortId, Map<tileKey, Buffer>>` per board,
LRU across `(board, sort)`, budgeted by `COARSE_BUDGET_MB` (1024 MB).
`materialiseSort` installs its own just-encoded buffers directly — the
first request never re-reads disk; `tiles.ts` loads a sort from disk
lazily otherwise. `X-Cache: resident` on a hit, `disk` as the fallback (a
sort too big for the budget). Measured: 500/500 `resident`, p50 0.50 ms,
p95 1.13 ms — against the 5 ms target. A fourth cache, alongside ladder
residency and the composed-tile cache: z ≤ −3 needs neither once
materialised.

Verify with `cd server && bun test tiles.test.ts materialise.test.ts`.

## The leak wasn't the caches — it was every Canvas this file ever created

docs/measurements/phase-5.md "After the leftovers", problem 1. The demo
server (this code) grew to 12.5 GB RSS over ~4 h of panning, against a
budgeted 4 GB ladder + 1 GB coarse + 64 MB composed tiles ≈ 5.06 GB. None of
the three caches above were over budget when this was found — `residentBytes()`
for each was honest about what it held. The gap was memory none of them
were tracking at all.

**Root cause, isolated with no DB and no real files** (same discipline as
this file's own materialise fix above): a bare `createCanvas(256,256)`,
`getContext`, `encodeSync('png')`, then letting the `Canvas` go out of
scope — repeated 20,000 times — held RSS at +5.3 GB. Forcing `Bun.gc(true)`
every 2,000 iterations made **no measurable difference** against never
forcing it at all. This is a stronger and different claim than the
materialise fix's own finding above ("V8's GC heuristics don't see the
native buffer, so it isn't collected *promptly*") — here, an explicit,
synchronous, forced GC against an object with zero remaining references
did not reclaim it either. The buffer is retained for the life of the
process once a `Canvas` is created; it is not a matter of GC timing. The
SAME 20,000 iterations against one REUSED canvas (`drawImage` + `encodeSync`
every time, the canvas object itself never recreated) held RSS flat.

**Owner, named**: re-ran the identical isolated reproduction under plain
`node --expose-gc` (v24.14.0, same `@napi-rs/canvas` 0.1.100 from this
repo's own `node_modules`, `global.gc()` forced every 2,000 iterations) —
8,217.8 MB (no force) vs. 8,221.4 MB (forced) at 20,000 canvases,
indistinguishable. Identical shape to Bun 1.3.14's own numbers above. This
rules out a Bun-specific N-API finalizer bug: the cause is
`@napi-rs/canvas` 0.1.100 itself not releasing a `Canvas`'s native raster
surface when its JS wrapper is collected, on any runtime tested. Every
other site below is a leak for exactly this reason, not a Bun quirk — a
future `@napi-rs/canvas` upgrade is the only fix that could remove the
pooling below rather than needing it.

Two call sites created a fresh `Canvas` on every request, unconditionally,
forever — the same defect class the materialise scatter fix above already
found and fixed in the batch path, un-fixed on the live one:

- **`tiles.ts#composeTile`** — a new destination `Canvas` on every composed
  tile (every miss past the composed-tile cache, i.e. most of z ≥ −2's
  traffic — this file's own "single-viewer latency" section above).
- **`ladder.ts`'s resident-page LRU** — `residentBytes()` (`cache.size *
  PAGE_BYTES`) was only ever honest about pages CURRENTLY tracked. Every
  eviction, followed by that page being read again later, created a brand
  new `Canvas` and threw the old JS reference away — but per the isolation
  above, the old canvas's native buffer was never actually freed. Under
  z=0/−1 thrashing (S=128's 62,500-page population is two orders of
  magnitude past what any real budget holds resident — this file's own
  numbers above), that's thousands of evict-then-reload cycles an hour,
  each one a real, permanent leak the budget's own accounting had no way
  to see.

**Fix, round 1 (wrong on its own): never let a page or tile Canvas become
garbage** by pooling — a free list capped at 32, drawn from before ever
calling `createCanvas`, canvas returned after use. **This does not bound
the leak by itself, and the lead's review caught it before it shipped**: a
cap bounds how many canvases are HELD, not how many are ever CREATED. A
cold pan fires far more than 32 concurrent `loadPageCanvas`/`composeTile`
calls at once (one z ≤ −1 tile touches hundreds of distinct S=128/S=32
pages, a browser fires many tiles together) — every one beyond the cap
still calls `createCanvas`, and every one the cap can't take back on
release is exactly as permanently leaked as the unpooled version. That is
the coordinator's 16 GB-in-12 s shape, reproduced directly with
`scripts/cold-burst-pan.ts` (many concurrent requests, immediately at
cold start, biased to the coarse zooms where one tile fans out over
hundreds of pages) — see "Cold-start burst" below.

**Fix, round 2: bound CONCURRENT CREATION, not held count.** The real
invariant is *canvases ever created ≤ resident budget + however many
loads/composes are allowed in flight at once*. `util/semaphore.ts` gates
`ladder.ts#getPage`/`paintLadder` (`PAGE_LOAD_CONCURRENCY = 16`) and
`tiles.ts#composeTile` (`TILE_COMPOSE_CONCURRENCY = 32`) — a burst past
the limit queues instead of allocating. The free lists themselves are now
UNCAPPED: since concurrent creation can't outrun the semaphore, nothing
returned to a free list needs to be refused. `boards/routes.ts`'s two
preview functions, `worker/jobs.ts`'s oversized-upload resize, and
`materialise.ts`'s destination-tile batch got the same treatment (see the
site audit below) — a semaphore where callers are otherwise unbounded
(`routes.ts`), reuse-by-resize (`canvas.width =`/`canvas.height =`, which
clears the canvas — same behaviour image-graph's
`image-graph-atlas-tiles.md` documents for this library) where output
dimensions vary per call instead of a fixed size.

**Fix, round 2 continued: pin what's being read.** "A canvas is read
synchronously right after its `await` resolves, so nothing can recycle it
mid-read" was true for one unshared caller, but the in-flight-dedup fix
below means several callers can share ONE promise and each resumes in its
OWN later microtask — a different eviction could in principle land between
two of those resumptions. `ladder.ts#withPage` pins the KEY before it ever
awaits (not after resolution — see its own comment for why that ordering
matters) and `pickEvictionKey` never selects a pinned entry;
`tiles.ts`/`routes.ts` were switched from the raw `getPage` to `withPage`.
See `ladder-fairness.test.ts`'s adversarial-interleaving test and its own
honest note on the limits of forcing this exact race in a plain test file.

**Site audit** (lead review: "each is a slow permanent leak on a
long-running server... pool or bound each one, or state why it cannot
grow"):

| site | fix |
| --- | --- |
| `tiles.ts#composeTile` | pooled + `TILE_COMPOSE_CONCURRENCY` semaphore |
| `ladder.ts` resident-page LRU | pooled + `PAGE_LOAD_CONCURRENCY` semaphore + pinning |
| `boards/routes.ts#originalPreview` | pooled (resize-reuse) + `PREVIEW_CONCURRENCY` semaphore |
| `boards/routes.ts#ladderPreview` | pooled (fixed size) + same semaphore, switched to `withPage` |
| `worker/jobs.ts` oversized-upload resize | pooled (resize-reuse); `WORKER_CONCURRENCY` (4 default) already bounds concurrency tighter than any semaphore would |
| `materialise.ts#allocateTiles` | pooled across `materialiseSort` calls (was recreating its whole 5,216-canvas batch every rebuild — the leak compounded per rebuild, not just per process) |
| `worker/tile-encode-worker.ts` | not pooled — a Bun `Worker` OS thread `EncodePool` spawns fresh per `materialiseSort` and always `terminate()`s; tearing down the thread reclaims everything regardless of this library's own finalizer, and the encode pool was already measured flat in isolation (phase-1-map.md's Fix 2: ~400 MB, 5,216 tiles) |
| `seed.ts` | not pooled — a one-shot dev script; the whole process exits when it finishes |

**Measured, `server/scripts/leak-pan.ts` (a continuous scripted pan,
`measure-map.ts`'s tile-walk shape, 8 concurrent) against the Synthetic 1M
board, `PORT=8815` under `systemd-run --user --scope -p MemoryMax=24G -p
MemorySwapMax=0`, RSS and `/metrics` sampled every 10 s:**

| | before (unpatched) | after (canvas pooling + accounting fix) |
| --- | --- | --- |
| duration | 900 s | 300 s (the curve is flat well inside 40 s either way — see below) |
| RSS trend | climbs ~200 s, then plateaus | flat from the first sample |
| RSS peak | 11.90 GB | 5.20 GB |
| RSS at end | 11.67 GB | 4.43 GB (budgets' sum: ladder 4 GB (calibrated) + coarse 114 MB + ~200–300 MB baseline ≈ 4.3–4.4 GB — matches) |
| requests served | 175,994 (900 s, 195.5 req/s) | 81,283 (300 s, 270.9 req/s — the fix also removed GC/allocation pressure that was slowing requests down) |
| ladder evictions | 1,105,446 (73,700/min) | 686,114 (137,223/min — see below) |

A second, un-pooled fix was needed to actually hit "budgets' sum plus a
stated overhead": see `CANVAS_OVERHEAD_FACTOR` below. Pooling alone (no
accounting fix) plateaued flat too, just at ~8.8 GB instead of climbing —
proof the unbounded leak was gone, but not yet proof the budget was
honest.

**The eviction rate is HIGHER after the fix, and that's the tradeoff, not
a regression.** `CANVAS_OVERHEAD_FACTOR` (below) shrinks `MAX_PAGES` from
4,096 to ~2,560 so the SAME `LADDER_BUDGET_MB` now bounds real memory
instead of overshooting it — a smaller resident set of a 62,500-page (S=128)
population thrashes more under the same access pattern. A miss now costs
compose latency (this file's own "single-viewer latency" numbers), never
memory growth; that swap is the whole point of the fix.

**Final verification, round 2 code, combined cold-burst + 15 min pan**:
the coordinator's own repro was 16 GB in 11.9 s, cold. Re-ran exactly that
shape — `scripts/cold-burst-pan.ts` (many concurrent requests immediately
at process start, biased to z=0/−1) followed immediately by 850 s of
`leak-pan.ts`'s steady 8-way pan, one continuous run, `MemoryMax=16G`
(the coordinator's own cap, tighter than the 24 G used above):

| | value |
| --- | --- |
| cold-burst phase | 1,200 requests, 0 errors, ~7 s |
| full run (burst + 850 s pan) | 222,014 tile requests, 17 errors (transient, not OOM) |
| RSS trend | flat for the ENTIRE run, burst included — no climb phase at all |
| RSS peak | 5.33 GB |
| RSS at end | 4.36 GB |
| ladder evictions | 1,890,380 (~133k/min average) |
| 16 GB cap | never approached — peak was 33% of it |

The full numbers (this run and the earlier 24 G ones) are in
docs/measurements/phase-5.md's "After the leftovers" section — this file
states the mechanism and the isolated proof; that file has the live-server
measurements in full.

Verify the mechanism with `cd server && bun test tiles.test.ts ladder-fairness.test.ts semaphore.test.ts` (the
existing "four painted cells" test still passes against a pooled canvas —
`ctx.clearRect` reproduces a fresh canvas's blank state exactly). Verify the
curve by re-running `cold-burst-pan.ts` then `leak-pan.ts` back to back
under the same `systemd-run` cap.

## Multi-board fairness: an active board gets a floor share of the ladder

docs/measurements/phase-5.md "After the leftovers", problem 2, following on
from this file's own "Built" section above ("this run is exactly the case
that rule's own... reasoning doesn't cover: 20 boards open at once, sharing
one process-wide `LADDER_BUDGET_MB`"). With one global LRU, every board's
resident pages are equally evictable by insertion order alone — a board
with a viewer RIGHT NOW has no more claim on residency than a board nobody
has looked at in an hour. Measured there: evictions ramping 10k → 93k/min
and z ≥ −2 composed-tile p95 regressing an order of magnitude under 20
concurrent boards.

**Design:** a board counts as active while it's been read from within
`LADDER_ACTIVE_WINDOW_MS` (env, default 5 min — long enough to survive a
viewer reading one tile and thinking, short enough that an abandoned board
stops holding a floor other open boards could use). Every active board
gets a floor share `MAX_PAGES / (active board count)`. `ladder.ts`'s
eviction loop picks the RESIDENT board furthest over its own floor (an
inactive board's floor is 0, so it's always picked first) and evicts ITS
oldest page — never a global-LRU scan filtered by eligibility (see
`ladder.ts`'s own comment on why: an early version scanned the global LRU
capped at a fixed depth for cost, and `ladder-fairness.test.ts` caught it
immediately — when one board's whole resident block sits at the front of
the global order and is bigger than the scan cap, the capped scan gives up
and evicts the protected board anyway, silently undoing the feature in
exactly the case it exists for). Picking directly by "which board is most
over" is a scan over the small number of boards holding anything resident,
not over the cache itself, so it stays cheap at the eviction rates measured
above.

This is a soft preference, not a reservation: the budget itself is never
exceeded to honour a floor, and if every resident board is at or under its
floor, the least-under one is still evicted so the process makes progress.
A `LADDER_BUDGET_MB` too small for the number of concurrently active boards
still thrashes — the floor changes WHO pays for that thrashing first, it
doesn't add memory. `GET /metrics` gains
`digsite_ladder_active_boards`.

**Measured**, `scripts/load-boards.ts` (6 boards × 200,000 images, 6
viewers, 3 minutes — a smaller version of the 20×500k/5min run above, same
`LADDER_BUDGET_MB` default), before and after (problem 1's canvas-pooling
and accounting fixes are in both "after" numbers — they're the same file):

| | before | after |
| --- | --- | --- |
| z=0 composed p95 | 36.0 ms | 25.9 ms |
| z=−1 composed p95 | 65.5 ms | 49.8 ms |
| z=−2 composed p95 | 100.2 ms | 87.4 ms |
| z≤−3 materialised p95 | ~18 ms | ~12.4 ms |
| evictions/min | 85,871 / 90,630 / 90,350 | 137,461 / 140,458 / 141,102 |
| RSS peak | 12.47 GB | 5.64 GB |

Eviction rate went UP, not down — `CANVAS_OVERHEAD_FACTOR` (problem 1)
shrinks the real page budget, so the same access pattern thrashes more.
Latency improved anyway, at every zoom, because the floor stops one
board's pages from being evicted by six OTHER boards' traffic before that
board's own next request can reuse them — the floor changes which
evictions happen, and fewer of them now land on a board mid-read.

Verify with `cd server && bun test ladder-fairness.test.ts` (a board
touched recently keeps close to its floor share while another active board
floods the cache with many times the remaining budget) and a re-run of
`load-boards.ts`'s smaller load.
