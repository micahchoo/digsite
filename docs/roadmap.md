# digsite — roadmap

Completion means a group can use it daily. Each phase has a contract in
`docs/phases/` and a test that says it is done. Status is kept here.

| # | phase | done when | status |
| --- | --- | --- | --- |
| 0 | Walking skeleton | ten e2e scenarios green; the two prototype regressions cannot recur | DONE 2026-09-21, 10/10 (`e2e/RESULTS.md`) |
| 1 | Make the map real | a million synthetic images on one board pan and re-sort at the prototype's numbers through the product code path | DONE 2026-09-22 (`measurements/phase-1-map.md`): materialise 24.5 s, coarse p95 1.1 ms, tiles and viewer pass; rank rebuild 2.5–3.2 s against a 2 s target, open (partition `board_ranks` by board; hardening) |
| 2 | Make the sheet complete | two people edit one sheet for an hour and the snapshot, rows and foreign views agree | built; canvas seam split in flight (`phases/2-sheet.md` §7); hour run dry-run only; open question: native canvas ported from image-graph as a second adapter |
| 3 | Groups people can live in | invite by link, roles in the UI, allowlists, leave/remove, rename/delete with claims accounted for | built both sides; lifecycle walk 9/9 on the server; real-server run of the web pending (`phases/3-groups.md`) |
| 4 | Storage and deployment | a fresh machine goes from zero to a running instance from the README | in flight (`phases/4-deploy.md`) |
| 5 | Hardening | rate limits, route audit against the access module, load at tens of millions across boards, observability | not started |
| 6 | Parked ideas, on evidence | private staging space, copy-on-promote choices, region/caption coupling | parked |

Sequence: 1 before 2, because the map is where the design could still be
wrong and the sheet is assembled from parts that already work. 3 and 4
can run beside 2.

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
