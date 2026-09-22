---
scope: [server/src/boards/tiles.ts, server/src/boards/ladder.ts]
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
- **The next lever is materialising coarse levels per sort.** z ≤ −3 is
  about 5k tiles per sort per million images, seconds on 32 cores with
  the ladder resident; after that the coarse zooms never miss. Not built
  yet. Build it before adding a smarter tile cache.
- **`X-Cache` and `Server-Timing` stay on every tile response.** They are
  how the number above was measured and how the next one will be.

Verify with `cd server && bun test tiles.test.ts`, then by panning the
seeded board with the ladder budget at 16 MB and at the default and
reading `Server-Timing` on the misses.
