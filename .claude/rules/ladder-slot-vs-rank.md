---
scope: [server/src/boards/**, shared/src/board/**]
tags: [board, ladder, rank, tiles, sort]
priority: high
source: hand-written
---

# board: a slot is an address, a rank is a position, and they are never the same thing

An image's **slot** is an integer per board, assigned at upload from
`boards.image_count`, never reused and never renumbered. The ladder
pages (`DATA_DIR/boards/<id>/ladder/<S>/page-<n>.png`) are keyed by slot
through `shared/src/board/ladder.ts#ladderAddress`. An image's **rank**
is its position under one sort, `0..N-1`, held in `board_ranks(board_id,
sort_id, rank, slot)`. A tile is a set of ranks; composing it means
looking up each rank's slot and then that slot's pixels.

This is image-graph's `overview.ts` split (atlas slots as addresses,
positions derived) moved server-side and given a pyramid. It is what
makes sort a one-time ~900 ms rebuild per million images and a tile 4–17
ms, measured 2026-09-21 (`../prototype/board/RESULTS.md`).

## What must stay true

- **Nothing renumbers a slot.** A deleted image keeps its slot; a
  missing original keeps its row with `missing = true`. Closing gaps
  would re-address every ladder page behind the gap (image-graph
  re-decoded the whole vault once for exactly this).
- **A rank table is rebuilt whole, never patched.** An upload marks the
  board's `board_rank_state` rows stale; the next `ensureRank` runs one
  `DELETE` + `INSERT … ROW_NUMBER()` in a transaction. Patching ranks
  in place per upload is how position and order drift apart.
- **Ranks are looked up with `unnest($1::int[]) JOIN board_ranks`**, not
  `WHERE rank = ANY($1)`: 5–7× faster at 4,096 ranks, the coarsest tile.
- **The grid arithmetic lives in `shared/src/board/grid.ts` and nowhere
  else.** `COLS = 1024`, `CELL = 128`, `TILE = 256`, zoom `z ∈ {0..−5}`
  with `cellPx = 128·2^z`. The server composes and the client clicks
  with the same functions; deck.gl's `OrthographicView` + `TileLayer`
  index matches this convention with no translation (verified against
  `research/deck.gl/modules/geo-layers/src/tileset-2d/`).
- **A sort key is a typed property or a column.** `sortId` is the only
  spelling; `parseSortId` refuses anything else, so a URL cannot smuggle
  SQL. Missing values sort last.
- **Ladder pages are written under a per-page lock.** Two uploads to
  one board land on the same page; read-modify-write without the lock
  loses one.
- **A pin or a selection on the map is a client overlay**, never baked
  into a tile. Tiles depend on `(board, sort, z, x, y)` and nothing about
  the viewer.

Verify with `cd server && bun test ranks.test.ts tiles.test.ts` and
`cd shared && bun test`.
