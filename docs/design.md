# digsite — design and build contract

This is the product repo. It is built from the design and the measured
numbers, not from the prototype code. The prototypes under
`../prototype/` are reference material: read them for a pattern, never
copy a file. Words: `../CONTEXT.md`. Reference clones: `../../research/INDEX.md`.

## What this scaffold is

A walking skeleton: every module of the product exists, is wired end to
end, and is thin. A person can sign up, make a group, invite someone,
upload pictures to a board, see them as a map, pull some into a sheet,
draw a region and an edge, and see that claim appear foreign on another
sheet. Nothing is polished; every seam is in its final place.

Numbers that shaped it (from `../prototype/*/RESULTS.md`, 2026-09-21, 32
cores, 122 GB, Postgres 16):

| what | number |
| --- | --- |
| rank query behind one tile, 1M images, warm, p95 | 0.10 ms (z=0) … 4.2 ms (z=−5) |
| rebuild one sort's rank table, 1M rows | ~900 ms |
| compose one tile, ladder pages resident | 4–17 ms |
| compose one tile, ladder pages NOT resident | 30–550 ms; miss p50 238 ms at a 256 MB ladder budget, 27 ms at 4.5 GB |
| composed-tile cache hit rate, one viewer panning | ~4 % |
| relay latency between two clients in one sheet | p50 2 ms / p95 3 ms |
| claim in sheet A visible foreign in sheet B | 2.8 s (1.5 s snapshot debounce + ≤ 3 s poll) |
| access check, warm, p95 | 0.28 ms; socket join gate 2.9 ms |

## Layout

```
app/
  CONTEXT.md            the words
  docs/design.md        this file
  .claude/rules/        the seams, scoped to their paths
  package.json          bun workspaces: shared, server, web, e2e
  docker-compose.yml    Postgres, bound to 127.0.0.1:5440 only
  shared/               @digsite/shared — pure, no DOM, no node APIs
  server/               @digsite/server — bun, node:http + socket.io, port 8800
  web/                  @digsite/web — Vite + React 19 + TS, port 5180
  e2e/                  Playwright, headless Chromium
  data/                 gitignored: originals and ladder pages
```

Stack: bun 1.3 workspaces, TypeScript strict with `noUncheckedIndexedAccess`,
Biome for lint and format, `pg`, Better Auth 1.7 with the organization
plugin (`teams: { enabled: true }`), `socket.io`, `@napi-rs/canvas`,
`@excalidraw/excalidraw` 0.18, `@deck.gl/*` 9.

Ports and names are chosen not to collide with the prototypes: container
`digsite-db`, host port `127.0.0.1:5440`, volume `digsite-db`, database,
user and password `digsite`. Never touch `digsite-pg`, `deploy-postgres-1`
or `penpot-postgres`.

Environment (`.env.example`): `DATABASE_URL=postgres://digsite:digsite@127.0.0.1:5440/digsite`,
`AUTH_SECRET`, `SERVER_ORIGIN=http://localhost:8800`,
`WEB_ORIGIN=http://localhost:5180`, `DATA_DIR=./data`,
`LADDER_BUDGET_MB=4096`, `INVITATION_EXPIRES_IN=172800`.

Root scripts: `bun run db:up`, `bun run db:migrate`, `bun run seed`,
`bun run dev` (server and web together), `bun run test` (every
workspace's `bun test`), `bun run check` (`tsc --noEmit` per workspace and
`biome check`).

## `shared/` — `@digsite/shared`

Pure functions and types both sides agree on. `bun test` covers every
function here; no DB, no DOM.

### `src/board/grid.ts`

```ts
export const COLS = 1024, CELL = 128, TILE = 256;
export const ZOOMS = [0, -1, -2, -3, -4, -5] as const;
export type Zoom = (typeof ZOOMS)[number];
export function cellOf(rank: number): { col: number; row: number };
export function rankOf(col: number, row: number): number;
export function cellPx(z: Zoom): number;                 // 128 * 2^z
export function perTileSide(z: Zoom): number;            // 256 / cellPx
export function tileRanks(z: Zoom, x: number, y: number): number[]; // n*n, row-major; cols ≥ 1024 → -1
export function tileWorld(z: Zoom, x: number, y: number): { x: number; y: number; size: number };
export function worldExtent(count: number): [number, number, number, number]; // [0,0,w,h] for count images
export function rankAtWorld(wx: number, wy: number): number;
```

Ranks ≥ the board's image count are empty cells; `tileRanks` does not
know the count, the caller does.

### `src/board/ladder.ts`

```ts
export const LADDER = [8, 32, 128] as const;
export type LadderSize = (typeof LADDER)[number];
export const PAGE = 512;
export function perPage(s: LadderSize): number;          // (512/s)^2
export function ladderAddress(slot: number, s: LadderSize): { page: number; x: number; y: number };
export function sizeFor(cellPx: number): LadderSize;     // smallest s ≥ cellPx, else 128
```

### `src/board/sort.ts`

```ts
export type PropertyValue = string | number | boolean;
export type PropertyType = 'text' | 'number' | 'boolean';
export type SortKey = 'name' | 'uploaded_at' | { property: string; type: PropertyType };
export type Sort = { key: SortKey; dir: 'asc' | 'desc' };
export function sortId(s: Sort): string;      // 'name.asc' | 'uploaded_at.desc' | 'p.text.year.asc'
export function parseSortId(id: string): Sort | null;
export const DEFAULT_SORT: Sort;              // uploaded_at desc
```

A `sortId` is what goes in a URL and in the `board_ranks.sort_id`
column. `parseSortId` refuses anything it did not produce.

### `src/sheet/elements.ts`

```ts
export const SHEET_LIMIT = 150;                // image-graph's EXPLORE_LIMIT, carried
export type Direction = 'none' | 'forward' | 'reverse' | 'both';
export type Properties = Record<string, PropertyValue>;
export type ImageData = { kind: 'image'; imageId: string };
export type RegionData = { kind: 'region'; imageId: string; label: string; properties: Properties };
export type EdgeData = { kind: 'edge'; relation: string; direction: Direction; properties: Properties };
export type ElementData = ImageData | RegionData | EdgeData;
export function imageGroupId(imageId: string): string;   // 'g-img-<imageId>'
export function fileId(imageId: string): string;         // 'img-<imageId>'
export function arrowheadsFor(d: Direction): { startArrowhead: 'arrow' | null; endArrowhead: 'arrow' | null };
export function directionOf(start: unknown, end: unknown): Direction; // the inverse
export function dataOf(el: { customData?: unknown }): ElementData | null;  // validates shape
```

### `src/sheet/fractions.ts`

```ts
export type Rect = { x: number; y: number; width: number; height: number };
export type Fraction = { fx: number; fy: number; fw: number; fh: number };
export const MIN_FRACTION = 0.01;
export function toFraction(region: Rect, image: Rect): Fraction;
export function fromFraction(f: Fraction, image: Rect): Rect;
export function clampFraction(f: Fraction): Fraction;    // 0..1, fx+fw ≤ 1, fy+fh ≤ 1, ≥ MIN
```

### `src/sheet/claims.ts` — the rows

```ts
export type RegionRow = { id: string; sheetId: string; sourceId: string; imageId: string } & Fraction & { label: string; properties: Properties };
export type EdgeEnd = { imageId: string; regionSourceId?: string };
export type EdgeRow = { id: string; sheetId: string; sourceId: string; source: EdgeEnd; target: EdgeEnd; direction: Direction; relation: string; properties: Properties };
export type ForeignRegion = RegionRow & { sheetName: string };
export type ForeignEdge = EdgeRow & { sheetName: string };
export type Foreign = { regions: ForeignRegion[]; edges: ForeignEdge[] };
export function claimId(sheetId: string, sourceId: string): string; // '<sheetId>:<sourceId>'
```

### `src/sheet/merge.ts`

```ts
export type Versioned = { id: string; version: number; versionNonce: number };
export function mergeByVersion<T extends Versioned>(stored: T[], incoming: T[]): T[];
```

Excalidraw's rule: higher `version` wins, tie broken by lower
`versionNonce`; an id only in one list is kept. This is the server's
snapshot merge; the client uses the package's `reconcileElements`.

### `src/sheet/project.ts`

```ts
export type SceneElement = Versioned & { type: string; isDeleted?: boolean; x: number; y: number; width: number; height: number; customData?: unknown; startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null };
export function project(sheetId: string, elements: SceneElement[]): { regions: RegionRow[]; edges: EdgeRow[]; unresolved: number };
```

A region whose image is not in the scene, or an edge whose end resolves
to nothing, produces no row and counts as unresolved. Deleted elements
produce no row. Region rect → `toFraction(region, image)`.

### `src/api.ts`

Request and response types for every route below, one type per route,
so `web/` never spells a payload by hand.

## `server/` — `@digsite/server`

bun, `node:http` so Socket.IO shares the port, Better Auth mounted at
`/api/auth/*` through `toNodeHandler` from `better-auth/node`. CORS to
`WEB_ORIGIN` with credentials. JSON everywhere; `401` without a session,
`403 {reason}` on `AccessDenied`, `404` for a missing object *only after*
access is decided (an object the user may not see is `403`, never `404`,
so existence does not leak).

### `src/auth.ts`

`betterAuth` with a `pg` Pool, `emailAndPassword`, `organization({ teams:
{ enabled: true, defaultTeam: { enabled: false } }, invitationExpiresIn,
ac, roles })`. The plugin's default `member` role may not create teams or
add team members (`research/better-auth/packages/better-auth/src/plugins/organization/access/statement.ts`),
which would 403 a plain member creating a private board. Widen it:
`member` gets `team: ['create','update','delete']` and the team-member
statements. The plugin's role check is the outer line; our access module
is the gate. `defaultTeam` is off so an organization does not carry an
invisible team.

Better Auth POSTs need an `Origin` header; the session cookie is
`better-auth.session_token`. Column names are camelCase, quoted.

### `src/db/`

`pool.ts` (one Pool from `DATABASE_URL`), `migrate.ts` (applies
`migrations/*.sql` in name order, records each in `schema_migrations`),
`migrations/0001_auth.sql` (the output of `bunx @better-auth/cli generate`
against `auth.ts`, committed), `migrations/0002_domain.sql`:

```sql
CREATE TABLE boards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       text NOT NULL,                 -- organization.id
  name         text NOT NULL,
  open         boolean NOT NULL,
  team_id      text,                          -- team.id when private
  created_by   text NOT NULL,                 -- user.id
  default_sort text NOT NULL DEFAULT 'uploaded_at.desc',
  image_count  integer NOT NULL DEFAULT 0,    -- next slot
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id    uuid NOT NULL REFERENCES boards(id),
  slot        integer NOT NULL,
  sha256      text NOT NULL,
  name        text NOT NULL,
  width       integer NOT NULL,
  height      integer NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by text NOT NULL,
  properties  jsonb NOT NULL DEFAULT '{}',
  missing     boolean NOT NULL DEFAULT false,
  UNIQUE (board_id, slot)
);
CREATE TABLE board_ranks (
  board_id uuid NOT NULL REFERENCES boards(id),
  sort_id  text NOT NULL,
  rank     integer NOT NULL,
  slot     integer NOT NULL,
  PRIMARY KEY (board_id, sort_id, rank)
);
CREATE TABLE board_rank_state (
  board_id uuid NOT NULL REFERENCES boards(id),
  sort_id  text NOT NULL,
  built_at timestamptz NOT NULL,
  stale    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (board_id, sort_id)
);
CREATE TABLE sheets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id   uuid NOT NULL REFERENCES boards(id),
  name       text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sheet_images (
  sheet_id uuid NOT NULL REFERENCES sheets(id),
  image_id uuid NOT NULL REFERENCES images(id),
  PRIMARY KEY (sheet_id, image_id)
);
CREATE TABLE sheet_snapshots (
  sheet_id uuid PRIMARY KEY REFERENCES sheets(id),
  elements jsonb NOT NULL,
  saved_at timestamptz NOT NULL
);
CREATE TABLE regions (
  id         text PRIMARY KEY,                -- claimId(sheet, source)
  sheet_id   uuid NOT NULL REFERENCES sheets(id),
  source_id  text NOT NULL,
  image_id   uuid NOT NULL REFERENCES images(id),
  fx real NOT NULL, fy real NOT NULL, fw real NOT NULL, fh real NOT NULL,
  label      text NOT NULL DEFAULT '',
  properties jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE edges (
  id                   text PRIMARY KEY,
  sheet_id             uuid NOT NULL REFERENCES sheets(id),
  source_id            text NOT NULL,
  src_image_id         uuid NOT NULL REFERENCES images(id),
  src_region_source_id text,
  dst_image_id         uuid NOT NULL REFERENCES images(id),
  dst_region_source_id text,
  direction            text NOT NULL,
  relation             text NOT NULL DEFAULT '',
  properties           jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ON images (board_id, uploaded_at DESC, slot);
CREATE INDEX ON images (board_id, name, slot);
CREATE INDEX ON regions (image_id);
CREATE INDEX ON edges (src_image_id);
CREATE INDEX ON edges (dst_image_id);
```

### `src/access/index.ts` — one function per intent

Each takes `(userId, objectId)`, returns the row or throws
`AccessDenied(reason)`. Nothing else in the server reads `member`,
`team` or `teamMember`. Every route and the socket gate call exactly one.

| function | rule |
| --- | --- |
| `groupForViewing(u, orgId)` | member of the group |
| `groupForInviting(u, orgId)` | owner or admin |
| `boardForViewing(u, boardId)` | member of the board's group AND (open OR on the allowlist) |
| `boardForUploading(u, boardId)` | same as viewing |
| `boardForCreatingSheet(u, boardId)` | same as viewing |
| `boardForManagingAllowlist(u, boardId)` | viewing AND (creator OR owner/admin) |
| `boardForCreating(u, orgId)` | member of the group |
| `boardsForListing(u, orgId)` | the boards `boardForViewing` would allow, in ONE query |
| `sheetForEditing(u, sheetId)` | `boardForViewing` on the sheet's board |
| `imageForViewing(u, imageId)` | `boardForViewing` on the image's board |

An owner not on a private board's allowlist is denied. That is the
decision, recorded in the prototype and kept.

`GET /_access/:intent/:objectId` → `{allowed, reason?, ms}` stays, for
the tests and for measuring. It is not a product route.

### Routes

Groups (`src/groups/routes.ts`):
- `POST /groups {name}` → organization with `u` as owner → `{id}`
- `GET /groups` → the user's organizations
- `POST /groups/:id/invite {email}` → `groupForInviting` → `{invitationId}`
- `POST /invitations/:id/accept`
- `POST /groups/:id/leave`; `DELETE /groups/:id/members/:userId` → `groupForInviting`
- `GET /groups/:id/members` → `groupForViewing`

Boards (`src/boards/routes.ts`):
- `GET /groups/:id/boards` → `boardsForListing` (a private board the user is not on is absent)
- `POST /groups/:id/boards {name, open}` → `boardForCreating`; private → create the team, add `u`, store `team_id`
- `GET /boards/:id` → `boardForViewing` → the board plus `imageCount`, `defaultSort`, the sortable keys (`name`, `uploaded_at`, and every property key with one type across the board's images)
- `PATCH /boards/:id {defaultSort}` → `boardForManagingAllowlist`
- `POST /boards/:id/allowlist {userId}`, `DELETE /boards/:id/allowlist/:userId` → `boardForManagingAllowlist`
- `POST /boards/:id/images` multipart, one or more files → `boardForUploading` → `[{id, slot}]`
- `GET /boards/:id/images?sort=<sortId>&from=<rank>&count=<n>` → `boardForViewing` → images in rank order (for click → image, and for picking sheet members)
- `GET /images/:id` → `imageForViewing`; `GET /images/:id/original`; `PATCH /images/:id {properties}` → `imageForViewing` (properties are board-owned; any viewer may edit, for now)
- `GET /boards/:id/tiles/:sortId/:z/:x/:y.png` → `boardForViewing` → PNG, headers `X-Cache: hit|miss`, `Server-Timing: rank;dur=…, compose;dur=…`, `Cache-Control: private, max-age=60`

Sheets (`src/sheets/routes.ts`):
- `GET /boards/:id/sheets` → `boardForViewing`
- `POST /boards/:id/sheets {name, imageIds}` → `boardForCreatingSheet`; ≤ `SHEET_LIMIT`, every image on this board; lays images out in a grid (cell 320, image scaled to fit 256) and writes the first snapshot
- `GET /sheets/:id` → `sheetForEditing` → `{id, name, boardId, images: [{id, slot, width, height}]}`
- `GET /sheets/:id/elements` → the snapshot
- `GET /sheets/:id/foreign` → `Foreign`: rows from OTHER sheets whose images this sheet holds (an edge needs both ends held)
- `GET /sheets/:id/rows` → this sheet's own rows
- `GET /stats` → `{scenes, broadcasts, snapshots, lastProjectionMs, foreignInScene}` where `foreignInScene` counts elements in any received scene whose `customData` has a `foreign` key; there is no such key in this design, so it must stay 0 — the counter exists to prove it

### Uploads and the ladder (`src/boards/upload.ts`, `src/boards/ladder.ts`)

One upload: read the file, `sha256`, decode with `@napi-rs/canvas`, cap
the longer side at 4096 (Figma's cap), write the original to
`DATA_DIR/boards/<boardId>/originals/<sha256>`, then in one transaction
`UPDATE boards SET image_count = image_count + 1 RETURNING image_count - 1`
as the slot, insert the image, mark every `board_rank_state` row stale.
Then paint the three ladder sizes into their pages at
`DATA_DIR/boards/<boardId>/ladder/<S>/page-<n>.png` (read page, draw,
write page; a lock per page so two uploads to one page do not race).
Square, the picture contained and centred on a neutral background.

The ladder store (`ladder.ts`) keeps decoded pages resident per open
board, an LRU across boards under `LADDER_BUDGET_MB`. Residency is what
makes a tile fast (27 ms vs 238 ms per miss, measured); the composed-tile
cache is not.

### Ranks and tiles (`src/boards/ranks.ts`, `src/boards/tiles.ts`)

`ensureRank(boardId, sort)`: if no state row or `stale`, rebuild the
whole table for that `(board, sort)` in one transaction —
`DELETE` then `INSERT … SELECT slot, ROW_NUMBER() OVER (ORDER BY …) - 1`.
Property sorts order by `(properties->>key)` cast to the declared type,
`NULLS LAST`, then `slot`. Never patch a rank table per upload.

`slotsForTile(boardId, sort, z, x, y)`: `tileRanks` from shared, then
`SELECT r.rank, r.slot FROM unnest($1::int[]) AS r(rank) JOIN board_ranks …`
(5–7× faster than `= ANY` at 4,096 ranks). Ranks with no row → `null`.

`composeTile(boardId, cellPx, slots)`: `sizeFor(cellPx)`, for each slot
the page from the ladder store, `drawImage` into a 256×256 canvas, PNG.
A composed-tile LRU of 64 MB keyed by URL, invalidated per board when
the board's ranks go stale.

### The sheet room (`src/sheets/room.ts`, `snapshot.ts`)

Socket.IO on the same port. The client's session cookie rides the
handshake. `join {sheetId}` → `sheetForEditing` → `joined {elements,
peers}` or `join-denied {reason}` and disconnect. `scene {elements}` is
the client's FULL syncable set; the server counts, relays to the room as
`scene {elements, from}`, and debounces a snapshot 1,500 ms after the
last one. Snapshot: `mergeByVersion(stored, incoming)`, store, then
`project` and replace this sheet's rows in one transaction. `peers
{users}` on join and leave.

### `src/seed.ts` — the dev fixture, through the real code paths

Users `owner`, `member`, `listed`, `outsider` at `@example.test`,
password `password1`. Group "Lab" by `owner`; `member` and `listed`
invited and accepted. Group "Other" by `outsider`. In Lab: open board
"Field" by `member` with 60 synthetic images (painted with
`@napi-rs/canvas`: hue = index·137.508 mod 360, a diagonal band, the
index as text, sizes varied) uploaded through `upload.ts`, each with
properties `{year: 1900 + i % 60, site: 'site-' + i % 5}`; private board
"Finds" by `owner`, allowlist `owner` + `listed`. Sheet "First pass" on
Field holding images 0..11; sheet "Faces" holding 6..17. Idempotent.

### Tests (`bun test`, DB required, each file creates what it needs)

- `access.test.ts` — the 35-cell matrix from
  `../prototype/groups/CONTRACT.md` re-expressed against this fixture:
  five users × seven intents, zero deviations; plus `boardsForListing`
  per user.
- `upload.test.ts` — upload two files; slots 0 and 1; ladder pages exist;
  `ladderAddress` finds non-transparent pixels.
- `ranks.test.ts` — a board of 20 images; each sort's ranks are a
  permutation of the slots; a property sort puts missing values last;
  an upload marks the state stale and the next `ensureRank` rebuilds.
- `tiles.test.ts` — tile `(0,0,0)` of the seeded board has its two
  first-row cells painted (ranks 0 and 1; ranks 1024 and 1025 need a
  board of 1,026 images); `X-Cache` is `miss` then `hit`.
- `snapshot.test.ts` — merge by version; project a scene with one image,
  one region, one edge; the rows match; a stale scene cannot roll back.

## `web/` — `@digsite/web`

Vite, React 19, TypeScript, `react-router` 7, Better Auth's React client
against `SERVER_ORIGIN`, `fetch` with `credentials: 'include'`. Plain CSS.
No UI library. Test hooks on `window.__digsite` so e2e drives functions,
not pixels.

Pages:
- `/` — sign in / sign up (email, password, name).
- `/groups` — the user's groups; create one; invite by email (shows the
  invitation id, since there is no mail); accept an invitation by id.
- `/g/:id` — the boards the user may see; create a board (name, open or
  private); members list with an add-to-allowlist control on a private
  board the user manages.
- `/b/:id` — the map. deck.gl `OrthographicView` + `TileLayer` with
  `BitmapLayer` sub-layers, `tileSize 256`, `minZoom -5`, `maxZoom 0`,
  extent from `worldExtent(imageCount)`, tiles from
  `/boards/:id/tiles/<sortId>/{z}/{x}/{y}.png` with credentials. The
  prototype confirmed deck.gl's tile index matches the URL with no
  translation. A sort `<select>` of the board's sortable keys and a
  direction toggle; the viewer's choice in `localStorage` per board,
  falling back to the board's default. Click → `rankAtWorld` → the image
  at that rank (via `GET /boards/:id/images?sort&from&count=1`) →
  toggles it in a selection list shown in a side panel; "New sheet" with
  a name creates one from the selection and navigates. Upload button
  (multipart, many files). A status line: zoom, tiles requested,
  `X-Cache` hit ratio, ms from sort change to first tile.
- `/s/:id` — the document. See below.

### The sheet page (`web/src/sheet/`)

`Sheet.tsx` mounts one Excalidraw with the snapshot, loads every image
file through `api.addFiles` from `/images/:id/original`, and holds the
`ExcalidrawImperativeAPI`.

`sync.ts`: in `onChange`, when the syncable set's `id:version` signature
changed, emit `scene` debounced 100 ms. `isSyncable(el) = !el.isDeleted ||
el.updated > now − 24 h` (Excalidraw's own tombstone window). There is no
foreign filter here because nothing foreign is ever in the scene. On
`scene` from the server: `reconcileElements(local, remote, appState)` then
`api.updateScene({elements, captureUpdate: CaptureUpdateAction.NEVER})`.

`tools.ts`: `drawRegion(imageId, fraction, label)`, `connect(fromId, toId,
relation, direction)`, `moveImage(imageId, dx, dy)`, `setRegionRect(id,
fraction)`, `copyForeign(foreignId)`, `select(id)`, `setProperty`,
`removeProperty`, `getElements()`, `getForeign()`, `getSelected()`,
`syncStatus()`. Region elements are `rectangle` in the image's group
(`imageGroupId`), clamped inside the image on every change. Edges are
`arrow` with `startBinding`/`endBinding` set by hand after
`convertToExcalidrawElements` (`{elementId, fixedPoint: [0.5, 0.5], mode:
'orbit'}`) and the reverse `boundElements` written on the two ends.
Arrowheads from `arrowheadsFor`.

`overlay/`: the foreign layer. `Overlay.tsx` renders an `<svg>`
positioned over the Excalidraw container, `pointer-events: none` on the
svg and `pointer-events: all` on each foreign shape. It reads
`appState.scrollX`, `scrollY` and `zoom.value` from `onChange` and the
current image and region elements from the scene, and computes every
foreign shape's pixels on every render: `fromFraction(row, imageRectNow)`
for a region, current end rects for an edge. `useForeign.ts` polls
`/sheets/:id/foreign` every 3,000 ms and holds the rows. A click on a
foreign shape sets `selectedForeign` in React state and stops
propagation; a drag does nothing; the pointer never reaches Excalidraw.
Dashed stroke, 70 % opacity, the label as text.

`Inspector.tsx`: for an own element, kind, label or relation, direction
select, properties as editable key → value rows with a type toggle. For a
foreign selection, the sheet name, "Jump to sheet" (`/s/<id>`) and "Copy
to this sheet" (`data-testid="copy-foreign"`). `copyForeign` reads the
row's fractions and places the copy against the image's rect *now*.

Status line (`data-testid="status"`): user, sheet, peers, foreign count,
last sync ms.

## `e2e/` — the walking skeleton, driven

Playwright, headless Chromium, `request` contexts with a cookie jar per
user, browser pages for the sheet. Runs against `bun run dev` after `bun
run db:migrate` and `bun run seed`. Each scenario has a hard assertion.

1. Sign in the four users; `GET /groups` per user matches the fixture.
2. Board list per user: `owner → [Field, Finds]`, `member → [Field]`,
   `listed → [Field, Finds]`, `outsider → 403`.
3. `member` uploads three PNGs to Field → slots 60, 61, 62; tile
   `(uploaded_at.desc, 0, 0, 0)` now shows them in its first cells
   (decode the PNG, assert painted pixels); second request is `X-Cache:
   hit`; a `year.asc` tile puts them where their year ranks.
4. `outsider` requests a Field tile → 403; `member` requests a Finds
   tile → 403.
5. `listed` creates a private board in Lab → 201 (the widened member
   role).
6. `member` opens "First pass" (page A), `listed` opens "Faces" (page B).
   A draws a region on image 8 and an edge 8 → 9 "resembles" forward.
   Within 6 s B's `getForeign()` has that region with the same fractions
   and that edge with `direction: 'forward'`; B's `getElements()` has no
   element whose `customData` has `foreign`; `GET /sheets/<B>/elements`
   has none either; `GET /stats` has `foreignInScene: 0`.
7. **The regression from the prototype.** In B, `moveImage(8, 100, 50)`,
   then in the same tick `copyForeign(<that region>)`. The copy's
   fractions equal the foreign row's (±0.001) and its rect equals
   `fromFraction(row, imageRectNow)`.
8. **Pointer on a foreign shape.** In B, a real `mouse.down` / `move` /
   `up` across the foreign region's screen position. The image under it
   has not moved; `getSelected()` reports the foreign selection;
   Excalidraw's `appState.selectedElementIds` is empty.
9. `outsider` connects a socket and joins A → `join-denied`.
10. Reload A: the region and the edge are back from the snapshot.

Write `e2e/RESULTS.md`: each scenario pass or fail with the number it
measured, and what did not work, plainly.

## Sequence

1. root + `shared/` (one agent) — everything else imports it
2. `server/` and `web/` in parallel, each against this file and `shared/`
3. `e2e/`, then `README.md` and `HANDOFF.md`

No git commits. `git init` was done by hand; the first commit is the
owner's.
