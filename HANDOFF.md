# HANDOFF — digsite product repo

Updated 2026-09-22 after the upload-throughput and interface Luna pass.
The product repository is `app/`; roadmap: `docs/roadmap.md`.
Nothing was deployed. The isolated functional preview uses ports 5292/8892.

## Interface and "making sense" in progress (2026-09-23)

A second session, working beside the server-roadmap one. Committed on main as it goes.
The user narrowed the product: sense-making comes from annotation and
connection; everything else is secondary. GeoCities is dropped.

Interface polish (phases 1-3): one token palette read by both canvases
(`web/src/theme/palette.ts`); `board/board.css` rewritten one rule per
selector; the board's side panel reordered and made quiet; every typed
glyph replaced by `web/src/components/Icon.tsx`; the top bar is a path.

Making sense (CONTEXT.md "Making sense", all seven parts built):
- Shared vocabulary: `GET /boards/:id/vocabulary`; every label and relation
  field is `components/TermInput.tsx` (suggests, catches respellings).
- Connect in one gesture: `sheet/ConnectLayer.tsx` handle, then
  `sheet/RelationPicker.tsx` names it where it lands.
- Evidence, confidence, note: first-class edge fields
  (`0016_making_sense.sql`); the rewritten `sheet/Inspector.tsx` shows both
  ends as crops (`sheet/evidence.ts`).
- Aliases: `term_aliases`, `PUT/DELETE /boards/:id/aliases`, intent
  `boardForAliasing`; read-time only. Merged from the board's Terms index.
- Reach: `GET /sheets/:id/reach`, drawn by `sheet/overlay/Reach.tsx`.
- Agreement: pure, from polled rows (`shared/src/sheet/sense.ts`).
- The board learns: Terms index (`board/Terms.tsx`), find by label or
  relation, corner marks on annotated cells, Explore answers first and draws
  the neighbourhood on the map.
- Keyboard loop: Region tool, Tab/Shift+Tab walk images in reading order.

Fixed on the way: claims drew under images after a reload. Saved native
scenes carry no index and `mergeByVersion` sorted them by id. Now the
renderer and hit test go by layer (`scene.ts#paintOrder`), and the merge
keeps stored order. The preview on 8892 was restarted on the current tree
by digsite-1b (migrated through 0020).

Six horizons follow (`docs/roadmap.md` § "Making sense — six horizons"),
with image-graph's patterns mapped to them in
`docs/ux/image-graph-patterns.md`. Horizon 1 so far:
- Lines go around the pictures between their ends: `sheet/routing.ts`
  (orthogonal A*, ported from image-graph; its search state carries the
  arrival axis, or it gave three bends where two do). Canvas, hit test and
  overlay labels all read `edgePaths`. Other sheets' lines are still
  straight.
- The selection sets the emphasis: `connection-emphasis.ts#focusOf`. Lines
  and regions not touching it go faint. Confidence is the line style:
  likely is dashed, unverified is dotted.
- Region labels were never drawn on the native canvas. It reads
  `customData.label`, and render.ts only read bound text. Now they are a
  chip above the corner (`labels.ts#regionChip`, shared by render, overlay
  and smoke).
- The details panel docks as a column when the sheet is 900 px or wider
  (a container query), and a sheet opens fitted.
- `sheet/shortcuts.ts` is the one key table, shown by `?`
  (`ShortcutsPanel.tsx`). A mode bar says what Region, Edge and Pan wait
  for, with Cancel. The first Esc cancels a half-made connection, the next
  leaves the tool.
- Right-click and Shift+F10 open `sheet-menu.ts` in `board/ContextMenu.tsx`,
  now keyboard-navigable. `CanvasHandle.hitAt` answers what the pointer is
  over.
- Board (the user asked for this): the view zooms to 800%. Tiles stop at
  z=0, and past z=0.5 `board/detail.ts` draws each visible cell's own
  preview.

Horizon 1 is done, and all of it is committed on main (no Claude attribution;
the user asked to commit as I go, 2026-09-23). Also done since then:
- Horizon 1 finish: captions under pictures, a dashed band around a group,
  cursors that say what a press will do (`gestures.ts#cursorFor`), the
  sheet header ("Relations on this sheet" chips, "No changes yet" /
  "Synced 5s ago").
- digsite-1b's seven frontend items: Find by Meaning (best 24, top 12 as
  pictures, Show more) and More like this; folder import from the Actions
  menu (`board/FolderImport.tsx`); a 507 stops the upload queue; captured
  camera properties shown as Taken / Camera / Place; a rank-less image
  opens instead of ignoring the click; shared API types.
- Horizon 2: Compare (`components/Compare.tsx`, `compare-view.ts`): side
  by side, swipe, overlay with a difference blend, one zoom for both.
  From a connection's details or two pictures in the tray. Stamps: who made
  and last changed a claim (`customData.made/edited`; digsite-1b signs them
  in the room). Replies on a claim (`claim_replies`, 0023,
  `sheets/replies.ts`, `sheet/Discussion.tsx`).
- Horizon 2 finished: extract a region as its own picture
  (`POST /images/:id/extract`, `boards/extract.ts`; the sheet places it
  beside its parent with `sheet/beside.ts` and connects "derived from").
- Horizon 3: "How are they connected?" (`board/path.ts`, `PathPanel.tsx`),
  and the web view (`board/WebView.tsx`, `web-layout.ts`): hop rings, bent
  lines so two claims on one pair read as two arcs, walk from a picture.
  Opens from Explore, the path panel, and a connection on a sheet.
- Horizon 3 also: the web of one relation, from the board's Terms; parts
  no edge joins sit side by side (`web-layout.ts#ringLayout`).
- Horizon 4: "Looks like" under a sheet picture (`sheet/LooksLike.tsx`):
  Bring here, then a click connects ("copy of" for a near-duplicate).
  "Copies of this picture" on the board (`board/Copies.tsx`, digsite-1b's
  `/duplicates`). Label suggestions as chips on a new region
  (`/label-suggestions`; the CLIP prompt is untuned until real labels).
- Horizon 5: `/b/<board>?image=<id>` and `/s/<sheet>?claim=<id>` links;
  "Export a report" (`sheet/report.ts`, `crop.ts`): one HTML file.
- Horizon 6: arrow keys walk pictures and a live region announces the
  selection (`arrow-walk.ts`, `announce.ts`); `smoke-surfaces.ts` checks
  dark mode and 390 px across the new surfaces, the tray, the side
  drawer, the keyboard panel and the sheet menu; CI uses a pgvector
  database. The sheet toolbar draws from the one `Icon` set.
- Roadmap item 7 and C3, client (`edc9594`): `lib/order-version.ts` notes
  each response's `X-Order-Version` per (board, sort). Tile URLs carry
  `?v=`, and a new token clears the tiles and refetches what ranks answered.
  `selection/range` sends `v`; a 409 selects nothing and says why. Walk
  claim 15 counts tile requests over the network in a fresh browser: a
  reload makes none, and a property edit brings them back once.

Found and fixed on the way:
- `smoke-sheet-surroundings.ts` hung forever on a failure (the five codex
  smoke trees; digsite-1b killed them).
- `statfs` overflowed on the 24 TB volume and every upload got 507
  (reported; digsite-1b fixed it, fed0b5d).
- The canvas cast wire elements to `SceneElement`; one without `groupIds`
  crashed Bring here. `canvas/native/restore.ts` restores every element
  at the only intake.
- On a phone, Find pushed the board's chrome 13 px off screen (grid items
  keep their content width; content-box plus padding); the map container
  now clips.
- Esc in a dialog also closed the picture's details and the shell's
  drawers; `lib/modal.ts#modalOpen` makes page key handlers stand back.
- `besideSpot` measured the element's own position instead of the spot.
- The phone's side drawer and the context menu were content-box wider
  than their placement; both border-box now.
- A label chip's press reached the draw layer, which captured the click.

Verify with `bun run smoke` (16 scripts), `bun run e2e:fresh` (all six
suites pass together; `IMPORT_ROOTS=<dir>` for walk claim 8), `cd web &&
bun test`, `cd shared && bun test`, and `cd server && bun test
replies-routes extract-routes making-sense access.test routes-audit`.

Open, needing the user: a read-only view for people outside the group
(horizon 5) is a decision about who may see what; the report covers
showing the work meanwhile. Also open: `shell.css` stacks overrides; the
shell's and group pages' inline SVGs (drawn on 16- and 24-unit grids)
sit outside `Icon`. Biome does not catch a hook after an early return.

## Server roadmap (2026-09-23)

All six stages built and measured; not committed. Server suite 132/133 (one
skip) on a throwaway DB; typecheck, Biome, seam lint clean. Every number:
docs/measurements/server-roadmap-2026-09-23.md.

- Stage 1: worker is a supervised child (WORKER=process), retires, is the
  OOM victim, jobs are leased (0015). 4 GB soak passed: import + 60-min pan,
  0 OOM kills. @napi-rs/canvas decodes nothing (its decoder rejects some
  valid PNGs); sharp decodes. Rules: worker-is-disposable.md,
  canvas-holds-its-sources.md.
- Stage 2: board_ranks gone (0017); order is board_rank_state.slot_order.
  1M rebuild 0.1-1.0 s.
- Stage 3: sharp decode, EXIF captured properties, page-grouped painting;
  folder import (0019, POST /boards/:id/imports, IMPORT_ROOTS). Upload rate
  limit 12,000/min.
- Stage 4: CLIP embeddings (EMBEDDINGS=on) in pgvector halfvec + HNSW
  (0020). digsite-db now runs digsite-postgres:16-pgvector (db/Dockerfile,
  same Alpine base; docker-compose.yml builds it). 1M search 8 ms.
- Stage 5: 1 API + 2 workers, 0 of 60,003 cells blank (audit-ladder.ts).
- Stage 6: metrics per process; disk guard (UPLOAD_MIN_FREE_GB, 507);
  backups skip models/ and keep BACKUP_KEEP; no OpenTelemetry.

The ONE demo to keep (agreed with digsite-7c): web http://localhost:5292,
API :8892, owner@example.test / password1234, DB digsite_preview_1790122818.
Restart it with /tmp/digsite-preview-server-restart.sh (now sets
IMPORT_ROOTS=/home/micah/Pictures and EMBEDDINGS=on). It has a
"Screenshots" board: 141 images, embedded, searchable.
Other session: digsite-7c owns find.ts claim filters, vocabulary routes,
sheets/**, web/**. Five orphaned codex smoke runs (8850-8852, 8891/5291)
are hung; the user decides whether to stop them.

## 20,000-image import and the OOM (2026-09-22)

A real browser import of 20,001 PNGs from the image-graph vault completed
with no failures, and reproduced the OOM: server RSS rose ~1.14 MB per
processed image to 24.2 GB. Cause: `@napi-rs/canvas` keeps what was drawn
into a canvas until it is encoded or resized, and `loadPageCanvas`'s resize
leaked on the upload paint path. Fix in `server/src/boards/ladder.ts`
(`willEncode`); rerun peaked at 2.9 GB, 799 s to all ready. Evidence:
`docs/measurements/bulk-import-20000.md`; rule:
`.claude/rules/canvas-holds-its-sources.md`. Not committed.

Isolated stack still running for the compact-grid retest: server
http://localhost:8893, web http://localhost:5293, database
`digsite_import_1790136976`, storage `../.preview/digsite_import_1790136976/`.
It holds two 20,001-image boards and one 200-image board.
Still open from roadmap item 1: native file-dialog delay (needs a person),
per-sort rank tables (needs a design choice), compact grid at 1M.

## Latest usability pass

The real upload log showed 77 rate-limited responses among 164 requests.
The old 120-files/minute default made a 20,000-file import take nearly three
hours. Defaults are now 6,000 files/minute and 600 Tus creations/minute;
explicit deployment overrides still win. The worker runs bounded batches
continuously while busy instead of starting another batch every 500 ms.
It no longer overlaps slow batches. The same 120-image processing workload
fell from 15.10 s to 1.90 s; 1,200 images processed in 21.36 s at 425 MB peak
RSS. See `docs/measurements/bulk-upload-throughput.md` for workload limits.
Multipart requests are bounded before parsing (100 MiB by default and at
most 100 files). Oversized declared and chunked bodies return JSON 413;
normal browser batches stay below these bounds.

The board map now has 16 fixed columns instead of 1,024. A 61-image board
forms four rows. Existing ranks, slots and selection IDs are unchanged.
Browser tile URLs and stored coarse tiles carry layout version 2. Old tiles
are ignored and reclaimed on the next materialisation; originals and ladder
pages remain valid. Rectangle dragging now selects only cells inside its
row/column bounds; Shift-click remains a linear range. The earlier million-
image performance results used the wide layout and must not be presented
as a new scale measurement of this compact layout.

Upload activity can collapse its file list while retaining counts and the
stop control. Metadata updates preserve the Deck instance and camera;
ready-image updates reload tiles while keeping their previous bitmaps.
File drops can enqueue uploads directly on the board. The shell and group
overview have clearer navigation, spacing,
typography and board previews. Sheet authoring now supports additive and
band selection, moving selected images together, and navigation gestures
through the drawing overlay. See the current browser acceptance checks.

## Current result

The user chose the native canvas and requested removal of Excalidraw.
The implementation, dependency, runtime switch and obsolete adapter tests are
removed. Native persistence still reads legacy saved scenes, including their
ordering and bound arrows. CI now runs the native canvas only.

A real acceptance run exposed a sheet startup race: the initial socket scene
could arrive before metadata allowed the canvas to mount. The room now joins
only after metadata for the current sheet arrives. A browser regression delays
metadata and checks the exact persisted region appears in a joining peer.

Bulk upload feedback was rebuilt after two reported 20,000-file selections.
The old panel mounted 20,000 rows. The replacement mounts at most 80, keeps
at most two transfers active across boards, retains the queue during route
navigation, and exposes a shell indicator. Counts distinguish queued,
uploading, processing, ready, failed, unconfirmed and canceled files.
Rate limits show a retry countdown; ambiguous writes are not resubmitted.
Stopping queued work allows current transfers to finish. A browser reload
loses queued File handles; accepted images continue processing on the server.

Processing checks now query accepted image IDs in groups of at most 500,
without ranks or the old newest-500 limit. Final resumable responses expose
the accepted image ID. Tus logging attaches before request handling so PATCH
completions are recorded. Original MIME types come from verified file bytes.
See `docs/measurements/bulk-upload-feedback.md` for evidence and limits.

The roadmap pass adds relation emphasis across owned and foreign connections.
Connection labels avoid occupied space. Foreign-region labels avoid owned
labels and one another, move with short leaders when needed, and stay
selectable. Layout is presentation-only; it never changes scenes or claims.
One text-measure canvas is reused per overlay to avoid pan-time allocation.

## Product work already present

- Discord-style group rail, board channels, nested sheets and quick switcher.
- Image-ID selections, tray ordering, sort/reload persistence, find/filter,
  and real-server selection acceptance checks.
- Live additions to mounted sheet peers, with a merged pending scene while
  assets load and a check against stale peer edits.
- Searchable thread browser with previews, archive/reopen, server-backed
  unread state, previous/next sheet links and a mobile details drawer.
- Phase 6 server contracts for threads, selections, find/filter, activity,
  and date/list properties. Board deletion handles their dependent rows.

Still open: thread participants; GeoCities themes, banner and guestbook;
richer typed-property controls and indexes; board claims and presence;
copy choices; full viewport search dimming; copy-to-board/download;
dedicated per-sort rank tables; and final product/scale closeout.
Private staging remains parked. The existing product mockups are not an
approved visual target; the user disliked them. Read the image-graph reference
and `docs/ux/interface-direction.md` before more visual work.

## Verification

- Isolated server suite: 95 passed, one skipped, no failures.
- Web unit suite: 146 passed, no failures.
- Shared unit suite: 53 passed; script tests: 4 passed in the preceding pass.
- Fresh real-server suites: mixed multipart/resumable uploads, board
  selection/live additions/archive, 10/10 core scenarios, 9/9 group lifecycle,
  and 9/9 collaborative-sheet checks including delayed metadata hydration.
- Two 20,000-file browser selections: 80 mounted rows, two held upload
  requests, feedback within 142 ms and 119 ms of input change. This checks
  browser queue behavior, not storage ingestion of 40,000 images.
- Real mixed upload test: 133 small images and one image over 8 MiB reached
  ready exactly once without rate-limit pauses. Status/auth/Tus logging tests pass.
- The 20,000-file responsiveness smoke checks panning, collapse/reopen,
  a fast chooser event, camera continuity on metadata refresh, retained
  pixels during delayed tile responses, and changed pixels afterward.
- All 14 browser smoke scripts pass: 12 in the full run, then the remaining
  two on focused rerun after correcting cell-boundary and optional-layer
  assumptions in the tests. Typechecks, Biome, seam checks and the production
  build pass.

Fresh test databases are created and dropped by `scripts/e2e-fresh.ts`.
It accepts selected suite paths, for example `src/upload-queue.ts`.

## Preview and historical OOM

Use http://localhost:5292, backed by http://localhost:8892.
Sign in as `owner@example.test` with `password1234`.
Database: `digsite_preview_1790122818`.
Storage: `../.preview/digsite_preview_1790122818/data`.
Persistent logs: `/tmp/digsite-preview-server.log` and
`/tmp/digsite-preview-web.log`. Request diagnostics are enabled.
The latest read-only database check found 1,034 ready images and no jobs.
Neither historical 20,000-file attempt could be traced conclusively.
Final browser verification opened the real board, Find controls and native
sheet with no runtime errors; the 390px layout had no horizontal overflow.

Keep this preview available. Remove only its processes, database and storage
when it is no longer needed. Port 5291 is an older stub preview; it does not
retain uploaded photos. The older demo at 5180/8800 is separate and was not
modified. Earlier inspection found its frontend up and backend down; do not
assume its current state from those old observations.

The historical demo OOM remains unconfirmed. The journal recorded two 16 GB
kills about 11 seconds after restart; sampling began after both crashes.
A separate ladder-cache reproduction grew RSS from 105 MB to 359 MB across
250 page loads. Resetting recycled canvases reduced it to 104–124 MB while
pixel checks passed. This proves a cache defect, not the historical trigger.
The harness is `server/scripts/repro-ladder-page-churn.ts`.
Opt-in `DIGSITE_REQUEST_DIAGNOSTICS=1` records bounded request-start/end and
memory breadcrumbs, retaining at most 128 active entries.

## Read first and invariants

Read `CONTEXT.md`, `docs/design.md`, `.claude/rules/`, and both files under
`../.brainstorm/`. The inspiration is
`/mnt/Ghar/2TA/DevStuff/notebook/obsidian-developing-plugins/image-graph`.

Boards own images; sheets own their claims. Foreign claims stay in a
presentation overlay, never the saved scene. Fractions are the fact; pixel
positions follow image geometry. Selection stores image IDs, never ranks.
Any member can create a board. A group owner excluded from a private board's
allowlist is denied. Do not reintroduce private staging or shared cross-board
image identity without a product decision.

Product PostgreSQL is container `digsite-db`, loopback port 5440. Other
containers/databases belong to unrelated projects and must not be touched.
