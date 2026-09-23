---
scope: [server/src/boards/**, shared/src/board/**]
tags: [board, ladder, rank, tiles, sort]
priority: high
source: hand-written
checks:
  - forbid: '\b(const|let|var)\s+(COLS\s*=\s*16|CELL\s*=\s*128|TILE\s*=\s*256)\b'
    in: [server/src/**, web/src/**, shared/src/**]
    except: shared/src/board/grid.ts
    message: redefines a grid constant; import it from @digsite/shared/board/grid
  - forbid: 'rank\s*=\s*ANY\s*\('
    in: server/src/**
    message: rank lookup with = ANY; use unnest($1::int[]) JOIN board_ranks
  - forbid: 'UPDATE\s+board_ranks\b'
    in: server/src/**
    flags: i
    message: patches a rank table; rebuild it whole
  - forbid: 'UPDATE\s+images\s+SET[^;]*\bslot\s*='
    in: server/src/**
    flags: i
    message: renumbers a slot
  - forbid: 'sort_id\s*=\s*''\$\{'
    in: server/src/**
    message: interpolates a sort id into SQL
  - require: 'unnest\(\$\d::int\[\]\)'
    in: server/src/boards/ranks.ts
    message: slotsForTile must use unnest($n::int[]) JOIN
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
  else.** `COLS = 16`, `CELL = 128`, `TILE = 256`, zoom `z ∈ {0..−5}`
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

## A sort nobody asks for is dead weight in every OTHER sort's index

docs/measurements/phase-5.md "After the leftovers", problem 3. `board_ranks`
hash-partitions by `board_id` (`0007_board_ranks_partitioned.sql`), but the
primary key is `(board_id, sort_id, rank)` — partitioning by `board_id`
alone does nothing for a SINGLE board's own accumulated `sort_id` history.
The "Synthetic 1M" board had been rank-rebuilt under five different sorts
across this repo's own testing history; all five shared its one partition,
so a rebuild of just `uploaded_at.desc` still paid B-tree maintenance
against ~5,000,000 rows that happened to share its bucket, not the
1,000,000 the rebuild itself was writing.

**Measured, in order:**

1. Baseline (5 accumulated sorts in the partition, freshly vacuumed):
   isolated `EXPLAIN (ANALYZE, BUFFERS)` on the rebuild INSERT, 3,119 ms
   (plus ~309 ms DELETE) — 6,012,293 buffer hits for 1,000,000 rows
   inserted.
2. **Sweeping every OTHER (board, sort) globally unrequested for
   1 hour** (`ranks.ts#sweepStaleRanks`, `scripts/sweep-ranks.ts`) dropped
   4,125,798 of the database's 5,162,236 `board_ranks` rows (374 stale
   sort histories, not just this board's) — `VACUUM ANALYZE` afterward
   confirmed the target board's own partition held almost exactly its
   live 1,000,000 rows. Re-measured the identical rebuild: 3,119 ms
   INSERT, buffer hits unchanged. **No measurable improvement.** A
   B-tree's insert cost is `O(log n)`; going from ~5M to ~1M rows in one
   partition changes its height by about one level, which this shows
   doesn't matter next to whatever else 6 buffer touches per inserted row
   actually costs.
3. **A dedicated, freshly-created table with no other data and no
   pre-existing index** (`CREATE TABLE`, unindexed bulk `INSERT` of the
   same 1,000,000 rows, then `ADD PRIMARY KEY` once): 1,089 ms insert +
   260 ms index build = **1,349 ms total** — under the 2 s target with
   room. The difference isn't table size; it's TOUCHING AN ALREADY-BUILT
   INDEX row by row versus building one once, in bulk, from a sorted set.

**Shipped: the sweep (`sweepStaleRanks`), not the dedicated table.** The
sweep is real and worth keeping — it deleted 80% of this database's
`board_ranks` rows as genuine, unrequested-in-an-hour garbage, and a
production board (one or two live sorts, not five) never reaches this
board's pathological history in the first place, so the sweep is what
keeps it from ever compounding into item 3's problem. It does NOT close
this specific board's gap to 2 s, and that's reported honestly above
rather than hidden.

The dedicated-table number (item 3) is real and worth someone building on:
the shape is a per-`(board, sort)` swap-in table (`CREATE TABLE ... AS`
then rename in), replacing the destination for `slotsForTile`,
`imagesInRankOrder`, `sections.ts`'s boundary query, `materialise.ts`'s
rank read, and `routes.ts`'s two direct `board_ranks` queries — four call
sites outside `ranks.ts`, all of which currently filter a shared table by
`board_id`/`sort_id` and would need either dynamic-identifier SQL or a
native partition-per-pair scheme verified to actually prune on those
columns. That's a schema redesign, not the "small server change" this
pass's scope allows — flagging for the lead with the number already in
hand rather than shipping it half-verified against the hot read path.

`sweepStaleRanks` touches only `board_ranks`/`board_rank_state`, global
across every board (not board-scoped — "sorts nobody has requested," not
"this board's sorts"), and is safe to run at any time: a swept
`(board, sort)` rebuilds transparently on its next request, the exact path
a `stale` one already takes. `last_requested_at` (0009_rank_sweep.sql) is
bumped by `ensureRank` on every request that finds the rank table already
fresh, throttled to once an hour per `(board, sort)` so the hottest read
path in the app doesn't pick up a write on every single tile request.

Verify with `cd server && bun test ranks.test.ts` (`sweepStaleRanks`'s own
test) and `bun run scripts/sweep-ranks.ts <olderThanDays>` against a real
database.
