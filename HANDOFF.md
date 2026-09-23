# HANDOFF — digsite product repo

Updated 2026-09-22 after the second Luna agent pass. Phases 0–4 and both canvas adapters are built. Roadmap: `docs/roadmap.md`.

The first pass committed the native canvas reset (`831efb3`), server/shared
contracts (`feecca2`), and selection/interface work (`78a5121`). The second
pass adds request diagnostics (`dcdfe8c`), live sheet additions and the
Excalidraw delete fix (`d3be875`), and thread/mobile/upload UI (`698b293`).
These changes run in the isolated local preview; nothing was deployed.

## Where things stand

Before this pass, `main` had 50 commits covering phases 0–4, phase 5 hardening
(access audit, limits, sessions, logs, metrics, CI with a fresh-database
e2e, scale debts, the canvas leak fix, ladder fairness, serialised rank
rebuilds), the UX audit and design (`docs/ux/`), the UX defect fixes,
and slice 1 of the design (the Discord shell).

Luna agents resumed the memory, selection, and server work, then reviewed
the server and rebuilt the interface. This pass read both files in `../.brainstorm/`
and the user's image-graph reference. See `docs/ux/interface-direction.md`.

- Slice 2 now includes find/filter controls and an Actions button.
  Selection writes use a queue and show their save status.
  A hard reload before a save finishes can still lose the pending change.
- The interface now has compact board controls, an image-first inspector,
  a group landing page, and responsive sheet controls. Upload activity uses
  a bounded, themed list. Completed batches refresh the board before the
  full upload finishes. Switching boards invalidates stale UI updates.
- Phase 6 includes thread data, saved selections, find/filter, activity,
  and date/list sort types. Board deletion now deletes the new dependent rows.
  PostgreSQL aggregates sortable property types before the server reads them.
- `e2e/src/board-selection.ts` checks the real browser and server together.
  It covers find, persistence, sort changes, tray order, sheet layout, and additions without duplicates.
  `scripts/e2e-fresh.ts` includes this acceptance check.

Later product slices and the dedicated per-sort rank table remain unfinished.
The existing stub smokes do not prove that the entire product design is complete.
Find highlights returned matches and shows truncation. Full nonmatch dimming needs a response limited to the current viewport.
Copy-to-board and download remain disabled. The neighbourhood menu opens Explore controls.
Sort preferences stay in browser storage. Saved selections use the server.
Adding images now broadcasts the committed scene to open sheet peers. Clients load
new image previews before applying it and retain one merged pending scene while
assets load. A two-user integration check covers a stale peer edit and rejoin.

The next Luna pass adds a searchable board thread browser with image previews,
unread state, archive and reopen. Opening a sheet marks it seen. The sheet has
previous/next navigation and a mobile details drawer. The relation control dims
other sheets' connections only; filtering owned connections still needs a
canvas presentation API. Label collision handling, thread participants, GeoCities
themes, board presence/claims, copy choices and richer property UI remain open.

The historical demo OOM remains unconfirmed. The journal records two
16 GB kills about 11 seconds after restart, at 15:23 and 16:14 local time.
The sampler started at 16:27, after both crashes. It did not capture their spikes.

A separate reproduction found native memory growth in the real ladder cache.
For 250 page loads with a one-page cache, RSS grew from 105 MB to 359 MB.
Resetting the recycled canvas before repainting reduced a repeat run to 104–124 MB.
Pixel checks passed in both runs. The harness is `server/scripts/repro-ladder-page-churn.ts`.
This result proves a cache defect, but not the exact historical crash trigger.
The demo worktree and database remain unchanged by this pass.
Opt-in `DIGSITE_REQUEST_DIAGNOSTICS=1` now logs bounded start/end breadcrumbs
and process memory for board/tile requests, including requests killed before
completion. It retains at most 128 active entries. This is instrumentation,
not proof of the historical cause.

## Validation so far

The current isolated server suite passed 83 tests, with one skipped and no
failures. The final web suite passed 161 tests. Package typechecks, Biome,
seam checks and the production web build passed.
All 13 registered smoke scripts passed across the full 12-script run and
the added sheet-surroundings check. The board smoke passed again after the
upload feedback fix, including an intercepted rejected batch.

Both fresh canvas runs passed board selection/live additions/thread archive,
10 walking-skeleton scenarios, 9 group lifecycle scenarios and 8 sheet-session
checks. The first Excalidraw run exposed stale canvas callbacks replacing a pending delete
before socket transmission. The adapter now keeps the applied scene until the
callback catches up. A focused unit regression and a deterministic browser
check verify that the deleted claim disappears from the server projection.
The final native run also passed the new deletion check. Both test databases
were dropped by their runners.

Upload status checks now retry within the existing 60-second window without
re-uploading accepted files. If confirmation remains unavailable, the UI says
so. Failed rows show a reason and a summary count. Unit tests cover transient
and persistent status-read failures; the browser checks rejected-batch feedback.

Latest demo check: port 5180 serves the older `../demo` frontend (HTTP 200),
but port 8800 refuses connections. The formerly transient user service
`digsite-demo-server` is no longer registered. The demo is not usable end to end.
The real preview runs on 5292 with its server on 8892. Login and an actual
upload passed. Sign in as `owner@example.test` with `password1234`.
Its isolated database is `digsite_preview_1790122818`; storage is
`../.preview/digsite_preview_1790122818/data`. Server PID: 1713523; Vite PID: 1716578 (launcher 1716552).
Request diagnostics are enabled on this isolated server. Browser login passed.
The latest upload to Finds has 20 ready images and no failed or pending jobs;
a separate browser confirmed the images render. The reported upload failure
has not been attributed to a specific failed request. A misleading status-read
failure path was fixed, but it is not confirmed as the cause of that report.
Keep this preview available for review. Remove only these processes, this
database, and this data directory when the preview is no longer needed.
The older UI preview on 5291 uses a stub on 8891. It renders synthetic tiles
and does not retain uploaded photos. Use 5292 for functional review.
Existing demo users use `password1`; new test seeds use `password1234`.

## Read first

`CONTEXT.md` (the words), `docs/design.md` (the contract), the four
rules in `.claude/rules/` (the seams). Each rule names the measurement
that justifies it and the test that verifies it.

`../.brainstorm/THREADS.md` and `../.brainstorm/sessions/0001-shared-image-canvas.md`
record the original decisions. Later decisions supersede the earlier locked-element approach.
Private staging remains parked. Board images remain board-owned. Sheets own their claims.

## Infra

- Product DB: compose service `db`, container `digsite-db`,
  `127.0.0.1:5440`, user/pass/db `digsite`, volume `digsite-db`. Loopback
  only on purpose (Docker ports bypass UFW on this machine).
- Prototype DB `digsite-pg` on `0.0.0.0:5432` may still be running and is
  LAN-exposed; it is not used here. `deploy-postgres-1` (5433) and
  `penpot-postgres` are other projects; never touch.
- Ports: server 8800, web 5180. The prototypes used 8787/8790/8791 and
  5173/5174; the board viewer's Vite on 5173 may still be up.

## Decisions carried into code

- Any member may create a board, private included; the plugin's `member`
  role is widened for team operations; `access/boardForManagingAllowlist`
  is the real gate.
- Foreign claims live on an overlay, never in the Excalidraw scene.
- Fractions are the fact; pixels are derived from the image's current
  rect at render, and `copyForeign` places against the image now.
- An org owner not on a private board's allowlist is denied.

## Next after the build

Materialise coarse tile levels per sort (the next lever named in
`tile-cache-is-for-the-second-viewer.md`); upload pipeline as a worker;
group-by section headers on the map; the parked private staging space.
