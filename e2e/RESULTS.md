# e2e/RESULTS.md

Run against the real stack: `bun run db:migrate`, `server/` on :8800
(`bun run dev`), `web/` on :5180 (`bun run dev`), `bun run seed` from the
root. Two consecutive full runs, both 10/10. `bun run test` from `e2e/`.

## The ten scenarios, as measured

1. **PASS** — sign in the four fixture users; `GET /groups` matches the
   fixture for each (owner/Lab-owner, member/Lab-member, listed/Lab-member,
   outsider/Other-owner).
2. **PASS** — board list per user: owner → [Field, Finds], member →
   [Field], listed → [Field, Finds], outsider → 403.
3. **PASS** — member uploads 3 PNGs to Field → three new sequential slots;
   tile `(uploaded_at.desc, 0, 0, 0)` decodes with its first two cells
   painted (non-background pixels); the same request repeated is
   `X-Cache: hit`; a `year.asc` tile ranks the three new images (no `year`
   property) at the very end, `NULLS LAST`.
4. **PASS** — outsider's request for a Field tile is 403; member's request
   for a Finds tile is 403.
5. **PASS** — listed creates a private board in Lab (the widened `member`
   role) → success (200, see "Mismatches" below for the one status-code
   note).
6. **PASS** — a region + a forward edge drawn on sheet A (First pass, by
   member) appear as foreign on sheet B (Faces, by listed) — **3.05–3.07s**
   to foreign, in the two full runs (contract number: 2.8s = 1.5s snapshot
   debounce + ≤3s poll; consistently a few hundred ms over — see "What did
   not work" below, not treated as a failure). B's `getElements()` has no
   `foreign`-keyed element; `GET /sheets/<B>/elements` has none either;
   `GET /stats` has `foreignInScene: 0`.
7. **PASS** — in B, `moveImage` then `copyForeign` in the same tick: max
   fraction delta **0.00000** (well under the 0.001 contract bound); the
   copy's rect equals `fromFraction(row, imageRectNow)`.
8. **PASS** — a real pointer drag across the foreign region's screen
   position moves no image; `getSelected().kind === 'foreign'`; Excalidraw's
   own `appState.selectedElementIds` is empty (see the `Sheet.tsx` debug
   hook added for this — "Files changed" below).
9. **PASS** — outsider's socket joins sheet A → `join-denied`.
10. **PASS** — reloading sheet A restores the region and the edge from the
    snapshot.

## Mismatches found

None on the "fix it, it's a slip" side of the boundary — `server/` and
`web/` integrate cleanly against `docs/design.md` and each other out of the
box: sign-in/CORS/cookies, every route shape, the tile pyramid, the socket
room, the foreign-claim projection and the overlay all worked on the first
real run against each other. One documentation-level looseness, not a code
defect:

- **Scenario 5's "→ 201".** `docs/design.md`'s own "Routes" section
  specifies `json(ctx.res, 200, ...)` for every create route, and
  `POST /groups/:id/boards` does answer 200 in `server/src/boards/routes.ts`.
  The e2e scenario list's "→ 201" reads as shorthand for "succeeds," not a
  literal status-code requirement; the e2e script asserts 200 (the actual,
  documented-elsewhere, and implemented contract) and treats that as a pass.
  No file changed for this.

## Files changed outside e2e/

- `web/src/sheet/Sheet.tsx` — added a debug-only global,
  `window.__digsiteSheetDebug = { getAppState: () => apiRef.current?.getAppState() ?? null }`,
  set once on mount. Scenario 8's hard assertion
  ("Excalidraw's `appState.selectedElementIds` is empty") needs a read of
  Excalidraw's own app state, and no product hook exposes one —
  `window.__digsite` (tools.ts) is the fixed, documented contract and
  deliberately has no raw-appState getter. This mirrors an existing,
  identical pattern already in the codebase: `web/src/pages/Board.tsx`'s
  `window.__digsiteBoard` ("A debug-only hook for the smoke script's
  screenshots — NOT part of the fixed window.__digsite contract"). Additive,
  10 lines, does not touch `Tools` or anything `docs/design.md` specifies.

No other file outside `e2e/` was touched. `server/` and `web/` needed no
integration fixes — see "Mismatches found."

## What did not work, and diagnosis

- **Playwright's `request` module is unusable under bun 1.3.14 here.**
  `request.newContext().post(...)` (and `.fetch(...)`) hang until Playwright's
  own 30s timeout the instant a response carries `Set-Cookie` — reproduced
  standalone, isolated from this app: `playwright-core@1.63.0`'s
  `_parseSetCookieHeader` calls `new URL(responseUrl)` with a *relative*
  `responseUrl` under bun's `fetch`/`http` shim, throwing
  `ERR_INVALID_URL` inside an event handler that never reaches the awaited
  call, so it just times out. The identical script runs clean under plain
  node. Since Better Auth's sign-in always sets a cookie, this breaks the
  "Playwright request context with a cookie jar per user" approach entirely
  for this stack. **Substitution:** `e2e/src/session.ts`'s `Session` is a
  small fetch-based session with a hand-rolled cookie jar — the same shape
  `server/src/seed.ts`'s own `Session` class already uses — for all HTTP
  (scenarios 1–5, and the API-side checks inside 6). Playwright's browser
  automation (`chromium.launch`/`newContext`/`page`) is unaffected by this
  bug and is used as directed for the sheet pages (scenarios 6–10); sign-in
  for those pages is done by copying the session cookie into the browser
  context via `context.addCookies(...)` (the "your choice" the task
  offered), not by driving the sign-in form.
- **Scenario 6's number consistently runs ~250–270ms over the contract's
  2.8s.** Not a failure — the scenario's own bound is "within 6s," which it
  clears by a wide margin both runs — but worth naming: the 2.8s figure
  (1.5s snapshot debounce + ≤3s poll) is a best case; this run's ~3.05–3.07s
  also carries the client's 100ms sync-emit debounce (`sync.ts`) on *two*
  separate writes (`drawRegion`, then `connect`), the socket relay leg, and
  wall-clock/process overhead from Playwright driving two real browser
  pages. All within design, not a defect.
- **Repeated runs leave debris**, since `docs/design.md`'s e2e section has
  no teardown step: scenario 5 creates a fresh, never-deleted
  `e2e-private-<timestamp>` board in Lab on every run (listed ends up on
  its own PASS's list on the next run), and scenario 6 leaves its region +
  edge on "First pass" (visible as extra dashed shapes and orphaned text
  labels in a "Faces" screenshot from a sheet with enough run history —
  cosmetic, not a correctness issue, and expected given no cleanup exists
  or was asked for). The script is written to tolerate this
  (`assertNames`' `tolerateDebris` flag, and scenario 6 identifying its own
  region/edge by a fresh random label each run) rather than to reset the
  database.
- **The tile-check literal in `docs/design.md` ("four painted cells")**
  needs ≥1026 images on Field; the seed has 60 (+ this run's own 6 test
  uploads). Scenario 3 checks the two in-range cells (ranks 0 and 1) per
  `server/README.md`'s own documented deviation and `server/src/test/tiles.test.ts`'s
  header comment — not re-litigated here.
- **One own test-authoring bug, fixed before the final runs (not a product
  mismatch):** the first attempt used a long, timestamp-based region label
  (`e2e-region-<Date.now()>`) for uniqueness. `convertToExcalidrawElements`
  (used by both `tools.ts#drawRegion` and `tools.ts#copyForeign`) auto-grows
  a container to fit its bound text; a label too wide for the drawn region's
  30%-width box wrapped to multiple lines and grew the box's height well
  past the requested fraction — genuinely correct Excalidraw behaviour, not
  a bug in either `server/` or `web/`. Fixed on the e2e side: the label is
  now a short random tag (`e2e` + 6 base36 chars) that fits on one line, and
  the drawn region is additionally pinned to the exact fraction with
  `setRegionRect` (a documented `window.__digsite` function) right after
  `drawRegion`, so scenario 6/7's fraction checks compare against an exact,
  intentional value rather than whatever `convertToExcalidrawElements`
  happened to produce.

## Confirmation

- Both dev servers (`server/` on :8800, `web/` on :5180) are stopped.
- `digsite-db` (127.0.0.1:5440) is left running, untouched otherwise.
