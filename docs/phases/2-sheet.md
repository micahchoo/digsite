# Phase 2 — make the sheet complete

The skeleton's sheet proves the seams: own elements sync, claims
project to rows, foreign claims live on the overlay. This phase makes
it the document a group works in. Words: `../../CONTEXT.md`. Rules:
`../../.claude/rules/foreign-never-in-scene.md` — binding for every file
under `web/src/sheet/`.

Done when a one-hour two-person session, scripted in
`e2e/src/sheet-hour.ts`, ends with the snapshot, the rows and both
sheets' foreign views in agreement, and `foreignInScene` at 0.

## 1. Drawing (`web/src/sheet/tools.ts`, `Toolbar.tsx`)

Excalidraw's stock toolbar is hidden (`UIOptions`); ours has four
tools: select, region, edge, pan.

- **Region**: drag on an image draws a `rectangle` in the image's group,
  clamped to the image, with a bound text label opened for typing on
  release. Grips are Excalidraw's; `onChange` clamps after every grip
  move and rewrites the element only when the clamp changed it (an
  unchanged rewrite bumps `version` and echoes through sync).
  **A label must never resize its region.** Excalidraw grows a
  container to fit its bound text (`convertToExcalidrawElements` did
  this in the e2e run and moved a fraction). Bind the text with
  `autoResize: false` and a fixed width from the region, truncate with
  an ellipsis in the text element, and assert in `tools.test.ts` that a
  200-character label leaves `fx, fy, fw, fh` unchanged.
- **Edge**: click a source (image or own region), click a target; an
  `arrow` with both bindings and the reverse `boundElements`, relation
  typed into the bound text on release, direction defaulting to
  `forward`. Dragging an image carries its edges through Excalidraw's
  own binding update.
- Delete: removing an image removes its regions and their edges (group
  delete); removing a region leaves its edges dangling and shown as
  stubs to the image.
- Undo and redo are Excalidraw's. Nothing foreign is in the history
  because nothing foreign is in the scene.

## 2. Inspector (`web/src/sheet/Inspector.tsx`)

For an own element: kind, label or relation (bound to the text
element), direction as four radio buttons that rewrite the arrowheads,
properties as key → typed value rows with add and remove. For an image:
name, size, its board properties editable through `PATCH /images/:id`
(board-owned, not part of the scene). For a foreign selection: sheet
name, who last changed it (`sheet_snapshots.saved_at`), Jump, Copy.
For several selected: count and a delete button.

## 3. Presence (`server/src/sheets/room.ts`, `web/src/sheet/presence.ts`)

`pointer {x, y, selectedIds}` events at most 20 per second per socket,
relayed to the room, never persisted. Peers drawn on the overlay as a
named cursor and a faint outline of their selection, in a colour from
the user id. The status line shows names, not ids.

## 4. Sheet from a neighbourhood (`server/src/sheets/neighbourhood.ts`)

`GET /boards/:id/neighbourhood?from=<imageId>&hops=<1..3>&relation=<optional>`
→ `{images: [{id, hops}], edges: EdgeRow[]}` computed over `edges` with
a recursive CTE, capped at `SHEET_LIMIT` images (breadth-first, nearest
first; `truncated: true` when the cap hit). The board page's detail
panel gets "Explore from here" with a hop count, showing the result as a
selection on the map and offering "New sheet" from it. The new sheet
lays images out in rings by hop (`shared/src/sheet/layout.ts`, pure,
tested) and includes the neighbourhood's edges as OWN edges only when
the creator ticks "copy connections"; otherwise they appear foreign
from their owning sheets, which is the honest default.

## 5. Dangling edges

An edge whose end is a missing image or a deleted foreign region is
drawn to the image's rect with a hollow arrowhead and listed in the
inspector under "dangling". "Remove dangling" is a button on the sheet,
undoable, and the only path that deletes them. The projection keeps
rows for dangling edges (`unresolved` counts them; they are not
dropped).

## 6. Sheet list and rename (`web/src/pages/Group.tsx`, `Board.tsx`)

Sheets listed under their board with image count and last save;
rename inline (`PATCH /sheets/:id {name}` under `sheetForEditing`).
Delete is phase 3.

## Tests

- `web/test/tools.test.ts`: the pure parts — clamp only rewrites when
  changed; direction ↔ arrowheads; ring layout is deterministic and
  overlap-free for 150 images.
- `server/test/neighbourhood.test.ts`: a 12-image chain with two
  relations: hops 1..3 return the right sets; relation filter; the cap.
- `e2e/src/sheet-hour.ts`: two browser contexts, 60 minutes compressed
  to ~5 (a scripted sequence of draw/move/relabel/delete/copy-foreign
  actions with random waits), then: rows == what is on screen, foreign
  views agree, `foreignInScene: 0`, undo stack contains no foreign id.

## Sequence

1. drawing + inspector (web) ‖ presence + neighbourhood + rename (server)
2. sheet-from-neighbourhood UI + dangling (web)
3. the hour run

## 7. The canvas seam — Excalidraw becomes an implementation detail

Added 2026-09-22 after using the app: with an edge selected the page
shows Excalidraw's whole properties panel (stroke, sloppiness, font,
layers), its menu, library, help button and footer, its hand-drawn
font on labels, and our toolbar and a debug status line beside them.
It reads as Excalidraw with extras. `Sheet.tsx` is 675 lines mixing
the socket, image loading, the change pipeline, presence, polling and
layout, and the stock toolbar is hidden by a CSS override.

The split, in the vocabulary of `codebase-design`: one deep module
owns Excalidraw; the rest of the sheet is product UI that talks to it
through a small interface and never imports the package.

### `web/src/sheet/canvas/` — the module

The only directory that imports `@excalidraw/*`. Enforced by the seam
linter (`.claude/rules/sheet-canvas-seam.md`).

```ts
// canvas/Canvas.tsx
export type CanvasProps = {
  initial: SceneElement[];            // the snapshot
  files: Map<string, string>;          // fileId -> object URL, loaded by the caller
  tool: Tool;                          // 'select' | 'region' | 'edge' | 'pan'
  onChange(scene: SceneChange): void;  // elements (own), viewport, selection
  onPointer?(p: PointerEvent): void;   // scene coords, for presence and DrawLayer
};
export type SceneChange = { elements: SceneElement[]; viewport: Viewport; selectedIds: string[] };
export type CanvasHandle = {
  elements(): SceneElement[];          // live, including deleted within the tombstone window
  apply(patch: ScenePatch, opts?: { history?: boolean }): void; // add/update/remove by id
  applyRemote(elements: SceneElement[]): void;                   // reconcile, never in history
  select(ids: string[]): void;
  viewport(): Viewport; setViewport(v: Partial<Viewport>): void;
  zoomToFit(ids?: string[]): void;
  undo(): void; redo(): void;
};
```

`SceneElement`, `Viewport`, `ScenePatch` and `Tool` are ours, in
`canvas/types.ts`, and are the only shapes that cross the seam; the
Excalidraw element type never leaves the directory. Behind the seam:
`UIOptions` that turn off every stock control (main menu, welcome
screen, library, help, footer, zoom, undo, the properties panel), the
`excalidrawAPI` callback identity trap, `CaptureUpdateAction`,
`reconcileElements`, `convertToExcalidrawElements`, version bumps,
`restoreElements`, the theme (`theme: 'light'`, our font set through
Excalidraw's font family as the app's UI font, no sloppiness, no
roughness), `renderTopRightUI`/`renderCustomStats` returning null, and
the CSS import. The properties panel is hidden by `UIOptions`; if
0.18 has no option for it the module hides it and says so in one
comment, the only CSS override allowed, inside the directory.

Interface facts a caller must know, in `canvas/README.md` (≤ 40
lines): `apply` with `history: false` never enters undo; `applyRemote`
never enters undo; `onChange` fires after every committed change with
OUR element type; element ids are stable strings; pointer coordinates
are scene coordinates.

### The product UI around it

- `Sheet.tsx` becomes composition only (≤ 200 lines): loads the sheet,
  owns the socket (`room.ts`, moved out of Sheet.tsx: join, scene in
  and out, presence, peers), owns the foreign poll, and lays out the
  page. Everything imperative goes through `CanvasHandle`.
- `tools.ts` is rewritten against `CanvasHandle` and `SceneElement`;
  the `window.__digsite` hook names and behaviours stay identical
  (e2e and every smoke depend on them).
- `Toolbar.tsx` gains our own zoom out/in/fit and undo/redo, so no
  stock footer is needed. Bottom-centre stays.
- The status line becomes a presence strip in the side panel header:
  the sheet name (rename inline), image count, who is here as named
  chips in their cursor colours, and a quiet "saved n s ago" from the
  last snapshot. The `data-testid="status"` element stays, visually
  hidden, carrying the same text for e2e.
- The side panel is `SidePanel.tsx` composed of `Header`, `Dangling`
  and `Inspector`, in the app's own CSS (`web/src/sheet/sheet.css`),
  no inline styles.
- Labels and relations render in the app's UI font at a fixed size;
  the region stroke, the edge stroke and the foreign dashed stroke use
  three colour tokens in `sheet.css`, and the selection outline is
  Excalidraw's, restyled through its CSS variables if it exposes them,
  else left.
- Images with no original load `/images/:id/preview` (server route,
  phase 3 server half adds it); a `missing` image keeps the placeholder.

### Done when

`bun run lint:seams` proves no `@excalidraw` import outside
`web/src/sheet/canvas/`; `web/test/canvas.test.ts` covers the
pure parts of the seam (patch application, scene-change diffing,
type conversion both ways); every smoke script and the e2e ten still
pass unchanged; and a screenshot of a sheet with an edge selected
shows only our toolbar, our side panel and the canvas.
