# The compact grid at a million images — 2026-09-23

Roadmap "Server — next", item 3: the phase-1 scale run repeated on the
16-column layout, which the earlier million-image numbers did not cover.
A synthetic board of 1,000,000 images (`server/scripts/synth.ts`, 62 s to
build), measured through the real HTTP routes by
`server/scripts/measure-map.ts` against a server with `WORKER=off` and
default budgets (`LADDER_BUDGET_MB=4096`). Same 32-core machine.

| | target | measured | |
| --- | --- | --- | --- |
| rank rebuild `uploaded_at.desc` | ≤ 2 s | 0.32 s | pass |
| rank rebuild `name.asc` | ≤ 2 s | 0.96–0.97 s | pass |
| rank rebuild `p.number.year.asc` | ≤ 2 s | 1.28–1.30 s (2.04 s on first use, which also builds the property's index) | pass |
| materialise z ≤ −3, one sort | ≤ 60 s | 24.0–24.8 s, 6,838 of 6,838 tiles | pass |
| coarse tile p95 after materialise | ≤ 5 ms | 1.28 ms (p50 0.54), 500/500 resident | pass |
| tile miss p95, z = 0 | ≤ 50 ms | 11.4 ms | pass |
| tile miss p95, z = −1 | ≤ 50 ms | 23.3 ms | pass |
| tile miss p95, z = −2 | ≤ 50 ms | 42.7 ms | pass, after the fix below |

## z = −2 needed one fix

The first run gave z = −2 a p95 of 67.7 ms. A tile there draws 64 cells
from the S=32 ladder, and on this board those cells sit on 61–64 different
pages, because upload order is unrelated to slot order. A cold tile cost
~100 ms and a warm one 2 ms: page loads, taken one after another because
`composeTile` awaited each inside its draw loop. It now loads a tile's
distinct pages at once before drawing (bounded by `getPage`'s semaphore),
which halved a cold tile to ~55 ms and moved every zoom's p95 down: z = 0
14.3 → 11.4, z = −1 34.9 → 23.3, z = −2 67.7 → 42.7 ms. A larger libuv
thread pool made no difference; the rest is per-page work on the main
thread.

S=32 pages for a million images are 3,907; the 4 GB ladder budget holds
2,560. z = −2 on a million-image board is therefore always partly cold, and
this is the zoom to watch if the budget shrinks.

`measure-map.ts materialise` counted 0 tiles present on the first run: it
looked under the pre-layout-2 path. It now asks `materialisedTileKey`.
