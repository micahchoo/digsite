# digsite — roadmap

Completion means a group can use it daily. Each phase has a contract in
`docs/phases/` and a test that says it is done. Status is kept here.

| # | phase | done when | status |
| --- | --- | --- | --- |
| 0 | Walking skeleton | ten e2e scenarios green; the two prototype regressions cannot recur | DONE 2026-09-21, 10/10 (`e2e/RESULTS.md`) |
| 1 | Make the map real | a million synthetic images on one board pan and re-sort at the prototype's numbers through the product code path | DONE 2026-09-22 (`measurements/phase-1-map.md`): materialise 24.5 s, coarse p95 1.1 ms, tiles and viewer pass; rank rebuild 2.5–3.2 s against a 2 s target, open (partition `board_ranks` by board; hardening) |
| 2 | Make the sheet complete | two people edit one sheet for an hour and the snapshot, rows and foreign views agree | DONE; native canvas selected by the user. Excalidraw implementation and dependency removed; legacy scenes remain supported. |
| 3 | Groups people can live in | invite by link, roles in the UI, allowlists, leave/remove, rename/delete with claims accounted for | DONE 2026-09-22: lifecycle walk 9/9 against the real server; ten-scenario run 8/10 with the two misses being fixture debris on the shared database (`phases/3-groups.md`) |
| 4 | Storage and deployment | a fresh machine goes from zero to a running instance from the README | DONE 2026-09-22: fs and s3 adapters, deploy/ compose with caddy, backup and restore round trip, e2e 10/10 on both storages (`phases/4-deploy.md`) |
| 5 | Hardening | route audit, abuse limits, sessions, operability, scale debts, CI with a fresh-database e2e (`phases/5-hardening.md`) | in progress |
| 6 | The product, designed | Discord shell, image-graph canvases, GeoCities personality; plus the seven brainstorm items the build missed (`phases/6-product.md`) | in progress: shell, selection, find/filter, thread browser/archive/unread, live sheet additions, mobile sheet details, relation emphasis and label collision handling; remaining product slices and per-sort rank tables stay open |
| 7 | Parked ideas, on evidence | private staging space, copy-on-promote choices, region/caption coupling | parked |

Sequence: 1 before 2, because the map is where the design could still be
wrong and the sheet is assembled from parts that already work. 3 and 4
can run beside 2.

The latest usability pass adds a compact 16-column board map, rectangular
drag selection, uninterrupted map updates during imports, bounded upload
requests, faster worker scheduling, native sheet group selection/panning,
and a polished shell with board previews. The five fresh-database acceptance
suites and all 14 browser smoke scripts pass. See
`measurements/bulk-upload-throughput.md` and `../HANDOFF.md` for measurements
and remaining work. The earlier million-image results used the 1,024-column
layout; repeat that scale run for the compact layout before calling scale
closeout complete.

## Phase 1 — make the map real

- Upload as a worker: the request stores the file and the row; a worker
  builds the ladder and marks ranks stale. Resumable uploads (tus) for
  large batches beside the multipart path.
- Coarse tile levels (z ≤ −3) materialised per sort after a rank
  rebuild; rebuilds debounced after a batch settles.
- Group-by section headers at sort-value boundaries; hover shows the
  image; click selects; selection is an overlay.
- The scale run: a million synthetic images through the product path,
  numbers recorded in `docs/measurements/`.

## Phase 2 — make the sheet complete

Region and edge tools with grips and bindings, inspector for label,
relation, direction and typed properties, presence cursors, sheet from
a neighbourhood (N-hop traversal over the rows as a server query),
dangling edges shown and cleaned only by a person.

## Phase 3 — groups people can live in

Invitation links, roles surfaced, allowlist management, leave and
remove, rename and delete for boards and sheets with what deletion does
to claims spelled out.

## Phase 4 — storage and deployment

Originals and ladder pages in object storage behind the access gate,
immutable URLs, a production compose file, backups, migrations on
deploy.

## Phase 5 — hardening

Carried in from phase 1: rank rebuild at 1M is 2.5–3.2 s against 2 s;
the remaining cost is the cross-board primary-key btree on
`board_ranks`. Partition by board, or measure `shared_buffers` above the
container's 128 MB, before adding anything else there.

Rate limits on upload and sockets, an audit of every route against the
access module, a load test across boards with the ladder LRU, error
pages, observability from the `Server-Timing` headers already emitted.

## Making sense — six horizons

Sense on a board comes from annotation and connection; everything else is
secondary. The first slice (vocabulary, one-gesture connect, evidence,
aliases, reach, agreement, the keyboard loop) is DONE and walked on the
real server by `e2e/src/sense-claims.ts`. Patterns borrowed from
image-graph are mapped per horizon in `ux/image-graph-patterns.md`.

| # | horizon | done when | status |
| --- | --- | --- | --- |
| 1 | The loop without friction | details docked, lines route around pictures, focus dims the rest, labels and captions on the canvas, confidence visible on the line, `?` shortcuts, mode bar, context menu | in progress |
| 2 | Claims you can trust | compare two pictures side by side; who said what and when; replies on a claim; extract a region as its own picture | open |
| 3 | A web you can walk | explore a connection or a relation; "how are A and B connected"; a graph view with hop rings | open |
| 4 | The machine suggests, never decides | suggested connections, labels and near-duplicates from embeddings, each accepted by a person | open; needs the embedding routes (digsite-1b) |
| 5 | Show the work | stable links to a claim or a view, a read-only view, a citable export | open |
| 6 | The quality floor | dark mode, phone width, arrow keys and an announcer, screenshots and the claims walk in CI | open |

## Server — next (2026-09-23)

Stages 1–6 of the first server roadmap are done
(`measurements/server-roadmap-2026-09-23.md`). Each item below has a test
that says it is done. Order: 1 and 3 first (correctness and an open
promise), then 2, 5, 4, then the rest.

| # | item | done when | status |
| --- | --- | --- | --- |
| 1 | Sheets across processes | sheet rooms live in one API process; share them over Postgres. Two API processes behind one proxy, two editors on one sheet, the edit-conflict tests pass | open |
| 2 | Narrow find at a million | a narrow query scans every property with `jsonb_each_text` (~1.2 s); index name and property text together. Narrow find under 100 ms at 1M | open |
| 3 | Compact grid at a million | the scale run from roadmap item 1, repeated on the 16-column layout: materialise time, pan p95, memory | open |
| 4 | Near-duplicates | from embeddings; 20 repeated captures in the owner's screenshots found, no false positives on the test set. Shared with Making sense horizon 4 | open |
| 5 | Meaning for a million photos | 75 ms per image is 21 h per worker; batch inference and more workers by default. 20,000 photos searchable in under 10 min | open |
| 6 | A map arranged by meaning | a sort that places similar images together; needs a new sort kind in the web. Maps cluster with maps on the owner's screenshots | open |
| 7 | Cacheable tiles | tile URLs carry the order's version; a repeat visit makes no tile request | open |
| 8 | Camera formats | HEIC and RAW through the folder import: a phone folder imports with no skip, or each skip explained | open |
| 9 | Restores, proven | a monthly drill restores the newest backup into a scratch database and passes a smoke test | open |

### Correctness investigations

Each is a suspicion with the cheapest test that would settle it. The
first two are confirmed by reading the code and need a failing test before
a fix; the rest are unproven.

| # | suspicion | cheapest test | fix if it holds |
| --- | --- | --- | --- |
| C1 | **Materialise stamps a rebuild it did not draw.** `materialiseSort` sets `materialised_at = now()` at the end whatever order it read; a rebuild during the run is marked materialised, and old coarse tiles are served until the next materialise. Confirmed in code. | hold a materialise open, rebuild the sort, release it; the stamped version differs from the drawn one | stamp only `WHERE built_at` is still the version it read |
| C2 | **A composed tile outlives its invalidation.** `tileFor` composes from order v1, a rebuild publishes v2 and clears the cache, then the v1 tile is stored under the same URL. Confirmed in code. | delay a compose, invalidate during it, request again; old pixels return | key composed tiles by order version (with item 7) |
| C3 | **One view mixes answers from two builds.** find, sections, search and tiles each read the order at their own moment; during a rebuild the map can dim ranks that moved. | rebuild during a find plus a tile burst; compare the ranks each used | every rank answer returns its order version; the client refetches on change |
| C4 | **A lease expires under a stalled event loop.** Renewal is a timer every 20 s; a synchronous stretch past 60 s (the materialise scatter at a million?) lets a second worker take the same job. | `monitorEventLoopDelay` in the worker through a 1M materialise; max stall against 20 s | yield inside the scatter, or renew from the work loop |
| C5 | **HNSW misses true neighbours.** The index is approximate. | on real embeddings, top-20 from the index against an exact scan | raise `ef_search` until recall is 0.95 or better |
| C6 | **Importing a folder twice duplicates every image.** Storage dedupes the bytes; `uploadOne` still makes a new row. | import the same folder twice; count rows | a product decision: skip files already on the board, or say so |
| C7 | **Two canvas defects are fenced, not understood.** Resizing an encoded page canvas leaked 1.1 MB per image; the decoder rejects some valid PNGs. | minimal repros against the latest `@napi-rs/canvas`; the second has a fixture | report upstream; remove the fences if fixed |
| C8 | **One supervisor test failure, seen once.** 748 ms, not reproduced in three reruns. | run `supervisor.test.ts` 200 times; keep the failing assertion | whatever the assertion shows |
