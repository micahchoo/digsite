---
scope: [server/src/boards/tiles.ts, server/src/boards/ladder.ts, server/src/boards/materialise.ts, server/src/boards/coarse-cache.ts]
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
