# @digsite/web

Vite + React 19 + TypeScript. See `../CONTEXT.md` for vocabulary and
`../docs/design.md` for the contract this implements.

## Pages

- `/` — sign in / sign up.
- `/groups` — the user's groups; create, invite, accept.
- `/g/:id` — a group's boards; create a board; members and allowlists.
- `/b/:id` — the map: a deck.gl tile pyramid over the board's images, sort
  and direction, click-to-select, upload, "new sheet" from a selection.
- `/s/:id` — the document: one Excalidraw scene per sheet, live-synced over
  Socket.IO, plus the foreign overlay below.

## The overlay seam

A claim from another sheet is never an Excalidraw element. `sheet/overlay/`
draws every foreign region and edge on an `<svg>` above the Excalidraw
canvas, computed fresh each render from the current image rects, never a
cached poll. It owns its pointer events (`all` on each shape, `none`
elsewhere), so a click or drag on a foreign shape never reaches Excalidraw.
See `../.claude/rules/foreign-never-in-scene.md` and `sheet/tools.ts`
(`window.__digsite`) for `copyForeign`, the one place a claim becomes own.

## Run

Against the real server: `bun run dev` from the repo root (after
`db:up`, `db:migrate`, `seed`). Against the stub, standalone:

```
bun install                 # from the repo root
cd web
bun run stub                # node:http + socket.io on :8800, no Postgres
bun run dev                 # in another shell, Vite on :5180
```

The stub seeds one group, two boards (`Field` open with 60 images, `Finds`
private) and two sheets on `Field` sharing images 8 and 9 — `Faces` polls
`Field`'s claims there as foreign. `bun run scripts/smoke.ts` drives both.
