# @digsite/web

Vite + React 19 + TypeScript. See `../CONTEXT.md` for vocabulary and
`../docs/design.md` for the contract this implements.

## Pages

- `/` — sign in / sign up.
- `/join/:id` — an invitation link, the one page reachable signed out:
  group and inviter, one message for expired/used, sign up/in then accept.
- `/groups` — the user's groups; create, invite, accept by id.
- `/g/:id` — boards with stats and recent sheets; create a board (one
  sentence each for open/private); invite (copyable `/join/:id` URL,
  pending list with revoke); members with role change/remove shown to
  everyone, a row's own 403 inline — the server decides; leave.
- `/b/:id` — the map (deck.gl tiles, sort, sections, hover, selection, a
  detail panel, upload, "new sheet"), rename/delete, allowlist, the sheet
  list, and `Explore.tsx`: "Explore from here" (hops 1–3, an optional
  relation) becomes the map selection and can lay itself into a "New
  sheet" (`ringLayout`, centres as `positions`); "copy connections" carries
  the neighbourhood's image-to-image edges in as own edges. Debug hooks:
  `window.__digsiteBoard` (`selectImages(ids)` is Explore's own entry point).
- `/s/:id` — the document: one native scene per sheet, live-synced over
  Socket.IO (`room.ts`) plus the foreign overlay below. `sheet/canvas/` owns
  the drawing surface; `CanvasHandle` and `SceneElement`
  are the seam everything else (`tools.ts`, `Sheet.tsx`, `DrawLayer.tsx`)
  talks through, enforced by `bun run lint:seams` (see
  `.claude/rules/sheet-canvas-seam.md` and `canvas/README.md`). `Toolbar.tsx`
  (select/region/edge/pan, zoom, undo/redo, keys V/R/E/H) sits bottom-centre,
  with product-owned controls. A missing image loads a
  drawn placeholder instead of fetching its preview (`images.ts`).

## The overlay seam

A claim from another sheet is never an owned scene element. `sheet/overlay/`
draws every foreign region/edge on an `<svg>` above the canvas,
computed fresh each render, and owns its pointer events (`all` on each
shape, `none` elsewhere) so a click/drag never reaches the canvas. A
foreign edge whose region end didn't come back in the latest poll draws to
the image instead with a hollow marker (`screen.ts#foreignShapes`'
`danglingStart`/`danglingEnd`) — overlay-only, never a scene change. See
`../.claude/rules/foreign-never-in-scene.md`; `sheet/tools.ts` for `copyForeign`.

## Presence

`sheet/presence.ts` is pure: `canSendPointer` throttles our own
`pointer {x,y,selectedIds}` emits to 20/s client-side, `colorForUser`
hashes a user id to a colour, `peerCursors` turns `pointer` broadcasts into
a named cursor plus a faint outline of each peer's current selection.
Drawn by `overlay/Overlay.tsx`; names come from `PeersPayload.peers`.

## Drawing

`DrawLayer.tsx` is the region/edge tools' pointer layer; what a press means
is one pure function, `gestures.ts#pointerIntent`. A label is typed into our
own floating input on release, truncated for DISPLAY only (`labels.ts`).
Deleting an image cascades to its regions and edges; deleting a region
rebinds its edges to the image, tagged `dangling` (`dangling.ts#applyCascade`).

## Run

Real server: `bun run dev` from the repo root (after `db:up`, `db:migrate`, `seed`). Against the stub, standalone:

```
bun install                 # from the repo root
cd web
bun run stub                # node:http + socket.io on :8800, no Postgres
bun run dev                 # in another shell, Vite on :5180
```

Seeds group "Lab", boards `Field` (open, 60 images) and `Finds` (private),
sheets `First pass`/`Faces` on `Field` (both hold images 6–11, foreign on
8/9); also mirrors the real `GET /boards/:id/neighbourhood` and
`POST /boards/:id/sheets`'s `positions`, plus two params/routes the real
server does NOT have yet — `GET /boards/:id/images?ids=` (+ a per-image
`rank`) and `GET /boards/:id/relations`; see `lib/api.ts`'s header
comments. Five fixed users, `<key>@example.test` / `password1`.

`bun run scripts/smoke.ts` (and `smoke-board`/`smoke-draw`/`smoke-groups`/
`smoke-explore`) drive it; if 8800 is taken, `PORT=8802 bun run stub` +
`VITE_SERVER_ORIGIN=http://localhost:8802 bun run dev`.
`cd ../e2e && HOUR_ACTIONS=20 bun run sheet-hour` dry-runs the hour script;
against the real server, omit `HOUR_ACTIONS` for the full ~200-action run.
