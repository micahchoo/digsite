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
  detail panel — image delete leaves a `missing` placeholder, never a hard
  delete — upload, "new sheet"), board rename/delete with a footprint
  confirmation, a private board's allowlist, and the sheet list (rename,
  per-sheet delete with a foreign-views confirmation). Debug hooks:
  `window.__digsiteBoard`; new response shapes typed locally in `lib/api.ts`.
- `/s/:id` — the document: one Excalidraw scene per sheet, live-synced over
  Socket.IO, plus the foreign overlay below. `Toolbar.tsx` (select/region/
  edge/pan, keys V/R/E/H) replaces Excalidraw's stock shape tools, hidden
  by CSS (0.18 has no `UIOptions` flag for one tool); zoom/undo stay. A
  missing image loads a drawn placeholder instead of fetching its original
  (`Sheet.tsx#loadImages`).

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
(`dangling.ts#applyCascade`). New hooks: `setTool`/`getTool`,
`pointerDraw`/`pointerConnect`, `deleteSelected`, `getDangling`/
`removeDangling`, `rename`.

## Run

Real server: `bun run dev` from the repo root (after `db:up`, `db:migrate`, `seed`). Against the stub, standalone:

```
bun install                 # from the repo root
cd web
bun run stub                # node:http + socket.io on :8800, no Postgres
bun run dev                 # in another shell, Vite on :5180
```

The stub seeds group "Lab", boards `Field` (open, 60 images) and `Finds`
(private, allowlist `admin`+`listed`), and sheets `First pass`/`Faces` on
`Field` sharing images 8/9 as foreign claims; also sections, footprints,
invitations/roles/allowlist, and upload (202 `pending` -> `ready` after
1s). Five fixed users, `<key>@example.test` / `password1`:
`owner`/`admin`/`member`/`listed` start in Lab, `outsider` in no group —
sign up as them on a `/join/:id` link. The stub picks the user from the
sign-in email's local part (no `?as=` needed, unrecognised -> `owner`).

`bun run scripts/smoke.ts` (and `smoke-board`/`smoke-draw`/`smoke-groups`) drive it;
if 8800 is taken, `PORT=8802 bun run stub` + `VITE_SERVER_ORIGIN=http://localhost:8802 bun run dev`.
