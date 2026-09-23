# HANDOFF — digsite product repo

Updated 2026-09-22 after the upload-throughput and interface Luna pass.
The product repository is `app/`; roadmap: `docs/roadmap.md`.
Nothing was deployed. The isolated functional preview uses ports 5292/8892.

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
