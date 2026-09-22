# digsite UX audit — 2026-09-22

Walked as `owner`, `member`, `listed`, `outsider` at 1440×900 and 390×844,
headless Chromium via Playwright (`docs/ux/scripts/*.ts`). Screenshots in
`docs/ux/screenshots/`, numbered per script run (the number is not a global
order — the filename is the key). Read first: `CONTEXT.md`,
`docs/phases/6-product.md`, the image-graph plugin's `styles.css`/`view.ts`,
and the notebook's `image-graph-*.md` rules.

**State of the product as found**: `web/src/style.css` is 105 lines of plain
CSS — "no UI library" — and every page is unstyled system-font HTML. None of
the three phase-6 metaphors (Discord shell, image-graph feel, GeoCities
personality) exist outside the sheet's own toolbar, which genuinely borrows
image-graph's tool vocabulary. This is the pre-design-pass baseline the
phase-6 audit is supposed to capture, so most findings below are about
*functional* friction (dead ends, silent failures, broken rendering), not
just missing paint — those are called out separately from pure visual gaps.

---

## Sign in — `/`

**First view.** A bare `<h1>digsite</h1>`, two toggle buttons ("sign in" /
"sign up"), an unlabeled-by-color form. A first-time visitor has no idea
what digsite is for — no tagline, no screenshot, no "log in to your Lab" —
just a login box (`001-signin-empty.png`).

| Finding | Evidence | Severity | Violates | Proposed change |
| --- | --- | --- | --- | --- |
| No product context above the fold — a stranger with a bookmark sees only a login form | `001-signin-empty.png` | minor | better-writing (empty-state points forward) | One sentence under the `<h1>`: what digsite is (e.g. "Arrange and connect your group's images.") |
| Mode toggle ("sign in"/"sign up") uses `disabled` as its only active-state cue — grey text, no color/underline | `002-signin-error.png` | minor | better-ui (state needs a static cue, not only one channel) | Add a filled/underlined active state distinct from disabled styling |
| Wrong-password error reads "Invalid email or password" — correct per better-writing (doesn't leak which field), no complaints | `002-signin-error.png` | — | — | Keep as-is |

---

## Join — `/join/:id`

**First view (valid invite, signed out).** "join a group" heading, a card
with "**Lab** — invited by owner", then sign-in/up toggle and fields
(`033-join-open-signedout.png`). Reasonably clear.

**First view (bad id).** A single line of text, "Invitation not found.",
with **no page chrome at all** — no header nav, no heading, no link home
(`037-join-not-found.png`, `009-m-join-not-found.png` at mobile). A dead end:
the only way out is the back button.

| Finding | Evidence | Severity | Violates | Proposed change |
| --- | --- | --- | --- | --- |
| Not-found / closed invitation pages have zero navigation — no way back to sign-in | `037-join-not-found.png` | major | better-layout (never park a critical action where it's unreachable); Discord metaphor (shell should always be present) | Wrap in the same page chrome as every other route, with a "sign in" link |
| A closed (already-used) and an expired invitation are, by design, indistinguishable ("no longer open") — documented and intentional per the code comment | `037-join-not-found.png` | — | — | Keep (deliberate, per access rules) |

---

## Groups — `/groups`

**First view.** "your groups" table (name / role / invite button), "create a
group", "accept an invitation". Functional, information-dense, no visual
hierarchy between the three cards (`003-groups-owner.png`).

| Finding | Evidence | Severity | Violates | Proposed change |
| --- | --- | --- | --- | --- |
| No Discord-style rail — groups are a table row you click into, not a persistent icon column | `003-groups-owner.png` | major | Discord metaphor (shell decision #1) | Left rail of round group icons, persistent across every page |
| "accept an invitation" by pasting a raw invitation id is a second, redundant path to the same action `/join/:id` already does with a real link | `003-groups-owner.png` | minor | better-writing (one path per task) | Cut it, or fold it into the same flow as pasting a full join URL |

---

## Group page — `/g/:id`

**First view.** Five stacked cards: boards (table), create a board (with
radio-button open/private explainer text — clear), recent sheets, invite,
members. No hierarchy — "create a board" gets equal visual weight to the
board list itself (`004-group-lab-owner.png`).

| Finding | Evidence | Severity | Violates | Proposed change |
| --- | --- | --- | --- | --- |
| Inviting with an empty email throws a raw 500 rendered as "Internal Server Error" — the field's own placeholder says "email (optional)", so a blank submit reads as supported | `005-group-lab-invite-empty-email-error.png` | **blocker** | better-writing (errors say how to fix); the server itself has a real bug here | Client-side: omit `email` entirely (not `''`) when blank. Copy: "Enter an email, or leave blank for a link anyone can use" |
| Re-inviting an email that already has a pending invitation also throws a raw 500 "Internal Server Error" | `008-group-lab-invite-repeat-email-error.png` | major | better-writing | Catch `USER_IS_NOT_A_MEMBER...`-style server errors and show "Already invited — copy the existing link below" |
| A nonexistent group shows a real error ("not a member of this group") **and** still renders full working-looking "create a board" / "invite" forms underneath it | `035-error-group-nonexistent-owner.png` | major | better-writing (misleading affordance) | Hide the action cards entirely when the page-level fetch failed |
| Board list mixes real content (Field, Finds, Synthetic 1M) with 8 undifferentiated test/debug/load boards ("1", "a", "sad", "Debug board", "load-1" at 500,000 images), unsorted by relevance | `003-m-group-lab.png` | minor (product-state, but a recurring pattern) | better-layout (order by importance) | Sort by `lastActivity`; archive/hide 0-image boards behind a toggle |
| Member role `<select>` and remove sit in a plain table row — no confirmation on role change or removal, unlike board/sheet delete which do confirm | `004-group-lab-owner.png` | minor | consistency | Same `Confirm` pattern used for board/sheet delete |

---

## Board page — `/b/:id` (the map)

**First view (Field, 118 images).** The deck.gl canvas auto-fits to a
**single, near-invisible pixel-thin strip** of colored cells near the
vertical center, surrounded by a vast empty white canvas — the actual
content occupies perhaps 2% of the screen (`009-board-field-initial.png`).
A first-time visitor has no idea there's anything to zoom into; nothing
hints "scroll to zoom in."

| Finding | Evidence | Severity | Violates | Proposed change |
| --- | --- | --- | --- | --- |
| **No visible zoom control at all** — zoom is mouse-wheel-only, no on-screen −/%/+/fit bar, no readout except a debug monospace status line the product doesn't intend end users to read | `009-board-field-initial.png`, `010-board-field-zoom-in.png` | **blocker** | image-graph metaphor (its own `.image-graph-zoom` bar is exactly this) | Port the plugin's zoom bar verbatim: −, tap-to-fit %, + |
| A fresh board's initial fit renders content as a 1-pixel-tall sliver — no "zoom to content" nudge or onboarding hint | `009-board-field-initial.png` | major | better-layout, first-run legibility | Default a wider initial zoom (2-3 cell-rows tall) instead of the mathematically-tightest fit |
| Nonexistent OR access-denied board ids hang on bare "loading…" **forever**, with no error, no timeout, no way to tell "still working" from "never going to load" — reproduced for owner (bad id), member (private board not on its allowlist), and outsider (board in a group they're not in), desktop and mobile | `034-error-board-nonexistent-owner.png`, `007-member-board-finds.png`, `019-outsider-board-field.png`, `011-m-member-error-board-nonexistent.png` | **blocker** (hit 5×, every denied/missing board) | phase-6's own checklist item ("403 you're not on this board's list... 404... offline/reconnecting"); better-writing | `getBoard().catch()` → render the actual 403 reason / 404, per the phase-6 spec already written for this |
| A genuinely valid but very large board (Synthetic 1M) also sits on bare "loading…" for ~4 seconds with zero progress feedback, indistinguishable from the broken case above until it resolves | `030-board-synthetic1m-initial.png`, `001-m-synthetic1m-longwait.png` | moderate | better-writing (loading state needs a distinguishing cue) | A spinner/skeleton, or GeoCities-flavoured "digging…" progress text |
| Hover tooltip (name + properties, ~150ms delay) works well and is genuinely pleasant | `014-board-field-hover.png` | — (positive) | — | Keep; reuse this component for the sheet's foreign-claim hover too |
| Clicking "Explore" from an image's detail panel **silently replaces the board's entire selection** with the explored neighbourhood — a deliberate 2-image selection (`image-53.png` + `image-55.png`) collapsed to 1 with zero warning the instant the anchor image had no connections | `013-board-field-selected.png` → `016-board-field-explore.png` | **major** | better-writing (no silent state loss); trust | Either merge into the selection, or show a confirm/toast: "Exploring replaced your 2-image selection" |
| Sheet list under a board shows "1 images" (no pluralization) | `017-board-field-reselected-for-sheet.png` | minor | better-writing (templated pluralization) | `${n} image${n===1?'':'s'}` |
| `RenameInline` board/sheet titles look identical to static bold text — nothing hints they're click-to-edit until the cursor happens to be a text-caret | `015-board-field-detail.png` | minor | better-ui (controls distinct from content) | Pencil icon on hover, or a dotted underline |
| At 390px, the board page is close to unusable: the (effectively) 300px-wide side panel eats ~77% of the viewport, the map canvas is squeezed to a sliver on the far left edge, and the sort/upload controls at top overlap ("Choose Files" runs into "No file chosen", the sort `<select>` is clipped by "desc") | `004-m-board-field.png` | **blocker** (mobile) | better-layout (hold structure until it breaks; nothing here adapts) | Collapse the side panel to a bottom sheet / drawer below `768px`; stack the top controls |
| Private board (Finds, 0 images) as an allowed user works correctly and cleanly | `032-board-finds-owner.png`, `015-listed-board-finds.png` | — (positive) | — | Keep |

---

## Sheet page — `/s/:id` (both canvases)

**First view (existing content, "First pass," excalidraw).** A scatter of
image cards connected by thin black lines, with many overlapping
dashed-outline "foreign claim" boxes carrying garbled, truncated ids
("r7w1nct", "relabel-efde", repeated "hour-run" labels stacked on top of
each other) — visually the densest, most cluttered screen in the app
(`028-sheet-firstpass-excalidraw.png`). Every image renders as a **generic
gray placeholder icon**, never the actual picture.

| Finding | Evidence | Severity | Violates | Proposed change |
| --- | --- | --- | --- | --- |
| **The Excalidraw canvas (the shipped default) never renders actual image content** — every image, in a brand-new sheet and in the year-old "First pass" sheet alike, shows a generic broken-image gray icon. The native canvas adapter renders the same images correctly (actual colors/labels) | `028-sheet-firstpass-excalidraw.png` vs `029-sheet-firstpass-native.png`; `023-sheet-uxaudit-region-committed.png` (gray) vs `027-sheet-uxaudit-native-canvas.png` (correct) | **blocker** | core purpose of the product | Fix the excalidraw adapter's `files` registration, or flip the default to `native` until it's fixed |
| A freshly created sheet **intermittently loads with 0 scene elements** despite the server holding a valid 2-image grid layout (`GET /sheets/:id` confirms both images present, not missing) — the canvas is silently, completely blank, "2 images" in the header but nothing drawable. A hard reload fixes it. Reproduced on the first retry | `038-repro-blank-sheet-race.png` (server-confirmed via `GET /sheets/:id`, same run) | **blocker** (intermittent — confirmed reproducible, not a one-off) | trust; no loading/error state distinguishes this from "done" | Find the race between the client-side `navigate()` after sheet creation and the room/scene join; block the empty-scene render behind a "loaded" flag, not just `sheetInfo` |
| The bottom-center toolbar sits directly on top of image content and labels with only a translucent white background — text and thumbnails visible underneath it | `028-sheet-firstpass-excalidraw.png` (toolbar overlapping the bottom-left image and its "hour-run" labels) | moderate | better-layout (controls distinct from content); image-graph metaphor (footer "pills," never a bar the canvas must make room for) | Solid background + shadow, or move off image-dense areas |
| Foreign-claim labels overlap into unreadable stacked text with no de-collision — multiple dashed boxes reading "relabel-efde", "r0bmv6l", "hour-run" ×4 pile on the same few pixels | `028-sheet-firstpass-excalidraw.png` | moderate | image-graph rule (`image-graph-hit-what-was-drawn.md`'s spirit: what's drawn must stay legible); better-typography | Port image-graph's label-avoidance system ("labels avoid images, captions, other labels; crowded labels stay hidden") |
| Presence chip shows the raw user id string (`YbFKWrYrhDdOtPZSUKVNJerfMTQzjSCE`) instead of a name | every sheet screenshot's side panel | minor | better-writing | `colorForUser`/chip should read `session.user.name`, not id |
| "not saved yet" shows on every fresh page load of a sheet with real saved history, reading as if the sheet has never been saved | `018-sheet-uxaudit-initial-excalidraw.png`, `028-sheet-firstpass-excalidraw.png` | minor | better-writing (accuracy) | Read the sheet's real `savedAt` on load instead of only this session's write events |
| Real region-drag (press-drag-release on an image) and the guaranteed `pointerDraw` entry point both work correctly and produce a labeled, selectable region; edge connect likewise draws a proper arrow and opens a working Inspector (relation/direction/properties) | `022-sheet-uxaudit-region-drag-result.png`, `026-sheet-uxaudit-inspector-edge.png` | — (positive) | — | Keep; this is the one place the image-graph feel is genuinely present |
| At 390px, the sheet toolbar (Select/Region/**Edge**/Pan/zoom/undo/redo) overflows the viewport width and is **clipped off both edges** — "Edge" reads as "dge", the undo icon is cut to a sliver — while the 280px side panel again eats most of the width | `006-m-sheet-firstpass-excalidraw.png` | **blocker** (mobile) | better-layout (breathing room, hold structure); better-accessibility (hit target off-screen = unreachable) | Wrap or horizontally scroll the toolbar; collapse the side panel below `768px` |
| Sheet name/board sort dropdown, and generally every `<select>`/`<input>` across Detail/Inspector, is unlabeled beyond a bare `<select>` — no `<label>` element, relies on visual proximity only | `015-board-field-detail.png` | minor | better-accessibility (label and type every control) | Add `<label>`/`aria-label` |

---

## Error cases, summarized

| Case | Result | Screenshot |
| --- | --- | --- |
| Nonexistent board id | infinite "loading…", no error, ever | `034-error-board-nonexistent-owner.png` |
| Private board, user not on allowlist (`member` → Finds) | infinite "loading…", no error, ever | `007-member-board-finds.png` |
| Board in a group the user isn't in (`outsider` → Field) | infinite "loading…", no error, ever | `019-outsider-board-field.png` |
| Nonexistent group id | real error shown, but page still offers working-looking forms | `035-error-group-nonexistent-owner.png` |
| Nonexistent sheet id | "join denied: sheet not found" — works, but the phrase "join denied" is real-time-collab jargon for what is really a 404 | `036-error-sheet-nonexistent-owner.png` |
| Nonexistent/closed invitation | clean, short message; no page chrome, dead end | `037-join-not-found.png` |

The **board case is the one to fix first** — it's the only one that never
resolves, and it's hit by the most common real mistakes (a stale link, a
board you were removed from, a typo).

---

## The three metaphors

### 1. Discord shell

**Today.** Doesn't exist. The top bar is a single "groups" link, the
signed-in email, and "sign out" — no group rail, no channel/thread column,
no quick switcher, no unread dots, no right-hand "who's here" outside the
sheet's own tiny presence strip. Every group→board→sheet step is a full
page navigation with no persistent "where am I."

**Top 5 changes:**
1. Left rail of round group icons, persistent on every authenticated page.
2. Second column: the current group's boards as `#channels` (lock icon for
   private), sheets nested underneath like threads.
3. Ctrl+K quick switcher across groups, boards, and sheets — the group
   page's own tables already have all the data this needs.
4. Activity/unread dots on boards and sheets, computed from the
   `lastActivity`/`savedAt` fields the API already returns.
5. Move role management and the allowlist into a "board settings" /
   "group settings" modal, out of the main page flow.

### 2. Image-graph plugin feel

**Today.** The one place this metaphor is real: the sheet's four-tool
toolbar (Select/Region/Edge/Pan), its zoom/undo/redo cluster, and the
dashed-foreign-region convention. Everything else — the board/map, the
Detail panel, Explore — is plain HTML with none of the plugin's density,
calm, or "one action, three surfaces" discipline (no right-click menus
anywhere in the app; delete/rename are small buttons scattered per row).

**Top 5 changes:**
1. Give the board an explicit zoom bar like the plugin's
   `.image-graph-zoom` — today there is no on-screen zoom control at all.
2. Rebuild the Inspector/Detail property editor as the plugin's
   name·format·value·remove grid instead of fixed 90px-wide text inputs.
3. One shared hover-card component for the board's image tooltip and the
   sheet's foreign-claim hover (currently two separate ad hoc
   absolutely-positioned `<div>`s).
4. A calm bottom status strip (selection count, tile cache ratio, sync
   status) styled as the plugin's monospace pill, replacing today's
   scattered debug-looking boxes.
5. Right-click context menus + a "?" shortcut-help overlay, with every
   action reachable the same three ways the plugin insists on (key,
   button, menu).

### 3. 2000s GeoCities personality

**Today.** Entirely absent — not even attempted. Every empty state is bare
text ("0 images", "none yet", "sheets (0)"); no banner, no visitor counter,
no guestbook feed, no badge chips, no webring nav, no theme picker, no
system-font chrome accent.

**Top 5 changes:**
1. A group homepage banner + a visitor-counter-style stat strip (images ·
   sheets · members) — the data already exists in `GET /groups/:id/boards`
   and `/members`.
2. Badge-style board chips (88×31-flavoured) replacing the plain `<table>`
   row in the group page's board list.
3. "Under construction" empty states for a 0-image board / 0-sheet group,
   replacing the bare counts.
4. Webring-style prev/next between a board's sheets, at the top of the
   sheet page (First pass ↔ Faces ↔ presence-smoke).
5. A small per-group theme picker, restricted to chrome (group/board
   surfaces) and explicitly never reaching into the map or sheet canvas —
   per phase-6's own rule that "the joke must never cost a click" inside
   the tools.

---

## Top 15 changes, ranked

1. **Fix the infinite "loading…" on any board the viewer can't or
   shouldn't see** (nonexistent id, private/not-on-allowlist, wrong
   group) — the single most consistent failure, hit 5× across every user
   tested, and the phase-6 doc already specifies the exact copy to show.
2. **Fix image rendering in the Excalidraw sheet canvas** — every image is
   a gray placeholder icon in the shipped default adapter; the native
   adapter renders the same data correctly.
3. **Fix the intermittent blank-sheet race** on sheet creation — a
   reproducible silent failure with valid server data and a dead client.
4. **Make Board and Sheet pages usable at 390px** — fixed-pixel side
   panels and an overflowing toolbar make both effectively non-functional
   on a phone.
5. **Give the board an on-screen zoom control** (−/%/+/fit) — today zoom
   is wheel-only with zero visible affordance, directly against the
   image-graph metaphor this phase is supposed to bring in.
6. **Stop "Explore" from silently discarding the board's selection** —
   warn, or merge, instead of a quiet overwrite.
7. **Fix the invite-by-email 500s** (empty email, repeat email) with real
   validation and recovery copy.
8. **Build the Discord shell** — persistent group rail + board/sheet
   column — so every page isn't a full reload with no "where am I."
9. **De-clutter the sheet canvas**: solid-background toolbar, label
   de-collision for foreign claims, so the densest screen in the app is
   readable instead of the messiest.
10. **Give RenameInline a visible affordance** — a hover pencil or
    underline — so clickable titles don't look like static text.
11. **Show real names, not raw ids, in presence chips.**
12. **Fix "1 images" and audit for other un-pluralized counts.**
13. **Start the GeoCities personality pass** — banner + visitor-counter
    stat strip on the group page is the cheapest, highest-visibility win
    (data already exists, zero new endpoints).
14. **Sort/archive the board list by relevance** — real content
    (Field/Finds/Synthetic 1M) is lost among test/debug/load boards today.
15. **Default the board's initial zoom wider** — a fresh board's auto-fit
    renders as a nearly invisible 1px sliver; nothing hints there's
    content to zoom into.
