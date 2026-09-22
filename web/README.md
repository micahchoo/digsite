# @digsite/web

Vite + React 19 + TypeScript. See `../CONTEXT.md` for vocabulary and
`../docs/design.md` for the contract this implements.

## Pages

- `/` — sign in / sign up.
- `/groups` — the user's groups; create, invite, accept.
- `/g/:id` — a group's boards; create a board; members and allowlists.
- `/b/:id` — the map: a deck.gl tile pyramid over the board's images, sort
  and direction, sections (`TextLayer` + `LineLayer`, hidden below z = -4),
  hover (150ms still -> a cached-per-sort tooltip), click/shift-drag
  selection (a `PolygonLayer` outline, capped at `SHEET_LIMIT`), a detail
  panel (click a selection-panel row; properties editable via `PATCH`),
  upload (`tus-js-client` over 8 MB, multipart batches of 10 otherwise,
  rows poll pending -> ready), "new sheet" from a selection. Debug hooks:
  `window.__digsiteBoard.{setZoom,getSelection,select,selectRange,clear,
  getLayerIds}`. Sections and upload status aren't in `@digsite/shared/api`
  yet, so `lib/api.ts` types them locally (`TODO`).
- `/s/:id` — the document: one Excalidraw scene per sheet, live-synced over
  Socket.IO, plus the foreign overlay below.

## The overlay seam

A claim from another sheet is never an Excalidraw element. `sheet/overlay/`
draws every foreign region and edge on an `<svg>` above the Excalidraw
canvas, computed fresh each render, and owns its pointer events (`all` on
each shape, `none` elsewhere) so a click/drag never reaches Excalidraw.
See `../.claude/rules/foreign-never-in-scene.md`, `sheet/tools.ts`
(`window.__digsite`) for `copyForeign`.

## Run

Real server: `bun run dev` from the repo root (after `db:up`, `db:migrate`, `seed`). Against the stub, standalone:

```
bun install                 # from the repo root
cd web
bun run stub                # node:http + socket.io on :8800, no Postgres
bun run dev                 # in another shell, Vite on :5180
```

The stub seeds one group, two boards (`Field` open with 60 images, `Finds`
private) and two sheets on `Field` sharing images 8 and 9 — `Faces` polls
`Field`'s claims as foreign. It also answers `/boards/:id/sections` and
upload with 202 `pending` -> `ready` after 1s, but has no tus, so a file
over 8 MB falls back to multipart there with a console note.
`bun run scripts/smoke.ts` and `scripts/smoke-board.ts` drive it; if 8800
is taken, `PORT=8802 bun run stub` + `VITE_SERVER_ORIGIN=http://localhost:8802 bun run dev`.
