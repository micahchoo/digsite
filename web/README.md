# @digsite/web

Vite + React 19 + TypeScript. See `../CONTEXT.md` for vocabulary and
`../docs/design.md` for the contract this implements.

## Pages

- `/` — sign in / sign up.
- `/groups` — the user's groups; create, invite, accept.
- `/g/:id` — a group's boards; create a board; members and allowlists.
- `/b/:id` — the map: a deck.gl tile pyramid, sort/direction, sections,
  hover, click/shift-drag selection, a detail panel, upload, "new sheet"
  from a selection, and the sheet list (image count, last save, inline
  rename via `components/RenameInline.tsx`, shared with `/s/:id`). Debug
  hooks: `window.__digsiteBoard`. Sections and the sheet list's stats
  aren't in `@digsite/shared/api` yet — `lib/api.ts` types them locally.
- `/s/:id` — the document: one Excalidraw scene per sheet, live-synced over
  Socket.IO, plus the foreign overlay below. `Toolbar.tsx` (select/region/
  edge/pan, keys V/R/E/H) replaces Excalidraw's stock shape tools, hidden
  by CSS (0.18 has no `UIOptions` flag for one tool); zoom/undo stay.

## The overlay seam

A claim from another sheet is never an Excalidraw element. `sheet/overlay/`
draws every foreign region/edge on an `<svg>` above the Excalidraw canvas,
computed fresh each render, and owns its pointer events (`all` on each
shape, `none` elsewhere) so a click/drag never reaches Excalidraw. See
`../.claude/rules/foreign-never-in-scene.md`; `sheet/tools.ts` for `copyForeign`.

## Drawing

`DrawLayer.tsx` is the region/edge tools' pointer layer; what a press means
is one pure function, `gestures.ts#pointerIntent`. A label is typed into our
own floating input on release, truncated for DISPLAY only (`labels.ts`) —
its container's width comes from the region, never the label. Deleting an
image cascades to its regions and edges; deleting a region rebinds its
edges to the image, tagged `dangling`, hollow arrowhead
(`dangling.ts#applyCascade` — its header comment says why it reads
`boundElements`, not the arrow's own binding). New hooks: `setTool`/
`getTool`, `pointerDraw`/`pointerConnect` (scene coords, also what
`smoke-draw.ts` drives), `deleteSelected`, `getDangling`/`removeDangling`, `rename`.

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
`Field`'s claims as foreign. Also answers sections, `PATCH /sheets/:id
{name}`, and upload (202 `pending` -> `ready` after 1s, no tus, so a file
over 8 MB falls back to multipart with a console note). `bun run
scripts/smoke.ts`, `smoke-board.ts` and `smoke-draw.ts` drive it; if 8800
is taken, `PORT=8802 bun run stub` + `VITE_SERVER_ORIGIN=http://localhost:8802 bun run dev`.
