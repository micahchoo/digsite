# Phase 1 — make the map real

The board is the surface the design could still be wrong about. This
phase takes the skeleton's board to product shape and then puts a
million images on it through the product code path. Words:
`../../CONTEXT.md`. Contract for the skeleton: `../design.md`. Rules:
`../../.claude/rules/ladder-slot-vs-rank.md`,
`tile-cache-is-for-the-second-viewer.md` — both binding here.

Done when `docs/measurements/phase-1-map.md` records, for a
1,000,000-image board through the real HTTP routes:

| number | target |
| --- | --- |
| rank rebuild, one sort | ≤ 2 s |
| tile miss p95, ladder resident, z = 0 … −2 | ≤ 50 ms |
| tile p95 at z ≤ −3 after materialisation | ≤ 5 ms (served from disk) |
| materialise z ≤ −3 for one sort | ≤ 60 s |
| viewer: sort change to first tile, rank built | ≤ 300 ms end to end |

## 1. Upload as a worker (`server/src/boards/upload.ts`, `server/src/worker/`)

Today the request decodes, paints three ladder sizes and writes pages
inline. Split it:

- The request: sha256, store the original, insert the image row with
  `status = 'pending'` (new column; `ready | pending | failed`), enqueue
  a job, respond `202 [{id, slot, status}]`. Slot assignment stays in
  the same transaction as the insert.
- `worker/index.ts`: an in-process loop started by `index.ts` (and
  runnable alone with `bun run worker`), polling a `jobs(id, kind,
  payload jsonb, state, attempts, run_after, created_at)` table with
  `SELECT … FOR UPDATE SKIP LOCKED`, concurrency from `WORKER_CONCURRENCY`
  (default 4). Job `ladder`: decode, cap at 4096, paint the three sizes
  under the per-page lock, set `status = 'ready'`, mark the board's rank
  states stale. Three attempts, then `failed` with the reason on the row.
- Rank rebuilds are debounced per board: a `rank-rebuild` job scheduled
  `run_after = now() + 2 s`, replaced if one is pending, so a batch of
  uploads causes one rebuild. `ensureRank` still rebuilds on demand when
  a stale sort is requested before the job runs.
- Tiles show a pending image as a neutral cell; a tile is not cached
  while any of its slots is pending.
- Resumable uploads: `@tus/server` with `@tus/file-store` mounted at
  `/boards/:id/uploads` under `boardForUploading` (the tus server's
  `onIncomingRequest` hook is where the gate runs; read
  `../../../research/tus-node-server/packages/server/src/server.ts`).
  `onUploadFinish` calls the same ingest function as the multipart path.
  Metadata `filename`, `properties` (JSON). The web upload button uses
  `tus-js-client` for files over 8 MB and multipart otherwise.

## 2. Materialised coarse levels (`server/src/boards/tiles.ts`, `materialise.ts`)

After a rank rebuild for `(board, sort)`, a `materialise` job composes
every tile for z ∈ {−3, −4, −5} and writes
`DATA_DIR/boards/<id>/tiles/<sortId>/<z>/<x>-<y>.png`, then records
`built_at` in `board_rank_state.materialised_at`. The tile route serves
from disk when the file exists and the state is not stale; otherwise it
composes as today. Materialisation runs with the ladder resident (load
S=8 and S=32 pages for the board first) and `WORKER_CONCURRENCY` tiles
in parallel. A stale rebuild deletes the directory before composing.

## 3. Sections, hover, selection (`server/src/boards/sections.ts`, `web/src/pages/Board.tsx`)

- `GET /boards/:id/sections?sort=<sortId>` → `[{label, fromRank, toRank}]`
  computed in one query over `board_ranks JOIN images`: for a property or
  name sort the boundaries where the value changes (name: first letter;
  number: the value; text: the value; boolean: the value); for
  `uploaded_at` the day. Cap at 500 sections; beyond that return the
  first 500 and `truncated: true`.
- The map draws a `TextLayer` label at each section's first cell, and a
  thin `LineLayer` before it, visible at z ≥ −4.
- Hover: after 150 ms still, fetch the image at the rank under the
  pointer (the existing `/images?sort&from&count=1`) and show name plus
  properties in a tooltip; cache by rank for the session.
- Selection: click toggles; shift-drag selects a rank range; the
  selection is a `PolygonLayer` of cell outlines on top of the tiles,
  never in a tile. The side panel lists selected images, has "New sheet"
  and "Clear".
- Detail: clicking a selected image opens a panel with the original
  (`/images/:id/original`) and its properties editable through `PATCH`.

## 4. The scale run (`server/scripts/synth.ts`, `server/scripts/measure-map.ts`)

`synth.ts <boardId> <count>`: inserts `count` synthetic images in batches
of 10,000 by SQL (`generate_series`, md5-derived name, year, site,
uploaded_at as in `../../../prototype/board/CONTRACT.md`), assigns slots,
and paints ladder pages directly with `@napi-rs/canvas` in parallel
workers (hue = slot·137.508 mod 360, the diagonal band, the number at
S=128 lazily). It does NOT go through the upload request per image — a
million HTTP uploads is not the thing being measured — but every row
and page it writes is exactly what the upload path writes.

`measure-map.ts`: against the running server as a signed-in member:
rank rebuild for three sorts (cold); 500 random tiles per zoom, warm,
p50/p95 with `Server-Timing` split; materialise z ≤ −3 for one sort and
then 500 random coarse tiles; the sort-change-to-first-tile time from
the real viewer through Playwright. Write
`docs/measurements/phase-1-map.md` with the table above filled in and
the machine described.

## Not in this phase

Object storage (phase 4), rate limits (phase 5), group-by as a data
model (sections are derived from the sort, never stored).

## Tests

- `worker.test.ts`: an upload leaves `pending`; running the worker once
  makes it `ready` with pages painted; a failing decode ends `failed`
  after three attempts.
- `materialise.test.ts`: after a rebuild + materialise on a 3,000-image
  board, every z=−3 tile file exists and the route serves it with
  `X-Cache: disk`.
- `sections.test.ts`: a board with years 1900..1905 gives six sections
  with the right rank ranges under `p.number.year.asc`.
- The existing five keep passing.

## Sequence

1. worker + tus (server) ‖ sections/hover/selection/detail (web + the
   sections route)
2. materialisation (server)
3. synth + measure, then the measurements file
