# digsite — the words

Read this before anything else in the repo. Code, tests, routes, tables and
prose use these words with exactly these meanings. A new concept gets a
line here before it gets a file.

## People and access

- **Group** — the unit of membership. A Better Auth *organization*. Joining
  is by invitation; an invitation is single-use and expires. Discord's
  "server".
- **Member** — a user in a group, with a role `owner`, `admin` or `member`.
  Roles are the plugin's. Any member may create a board.
- **Board** — belongs to one group; holds its own **images**. Either
  **open** (every member of the group) or **private** (only members of its
  **allowlist**). Discord's "channel".
- **Allowlist** — a private board's set of members. A Better Auth *team*
  in the board's group. A user who leaves the group leaves every allowlist
  in it (the plugin deletes the rows in the same transaction).
- **Intent** — one reason to touch an object: *viewing a board*, *creating
  a sheet on a board*, *managing a board's allowlist*. Each intent is one
  function in `server/src/access/` that returns the object or throws
  **AccessDenied**. The predicate is
  `member(user, group) AND (board.open OR member(user, allowlist))` and is
  written nowhere else.

## The board is a map

- **Image** — a picture uploaded to one board. Identified by a UUID `id`.
  Carries `name`, `uploaded_at`, pixel size, and typed **properties**.
  Images are board-owned; the same picture on two boards is two images.
- **Slot** — an integer per board, assigned at upload in order, never
  reused, never renumbered. The image's *address* in the ladder.
- **Ladder** — the image's pixels at 8, 32 and 128 px square, stored in
  512 px **pages** keyed by slot. Built once, at upload.
- **Sort** — an ordering of a board's images: by `name`, `uploaded_at` or a
  typed property, ascending or descending. Each viewer chooses; the board
  has a **default sort**. Images without the sort's value come last.
- **Rank** — an image's position under one sort: `0..N-1`. Held per
  `(board, sort)` as one **order**: every slot in rank order
  (`board_rank_state.slot_order`), rebuilt whole, never patched.
- **Cell** — where a rank sits on the map: fixed 128-unit squares, 16 per
  row, row-major. `col = rank % 16`, `row = rank / 16`.
- **Tile** — a 256 px PNG of the cells in one square of the map at one
  **zoom** `z ∈ {0..−5}`. Composed on request from the ladder, cached.
- **Missing** — an image whose original is gone. Kept as a row, shown as
  such, never deleted by the system.
- **Captured properties** — properties the worker reads from an
  original's EXIF once (`taken`, `taken_at`, `camera`, `lens`, `focal_mm`,
  `iso`, `aperture`, `exposure_s`, `latitude`, `longitude`). Merged under
  the image's own properties: a value a person set always wins.

## The sheet is a document

- **Sheet** — a permanent, named document under a board, holding up to 150
  of the board's images, hand-arranged, edited live by several people.
  One native canvas scene. Inherits its board's access. Discord's "thread".
- **Element** — a versioned element in a sheet's scene. Every element the
  app makes carries `customData.kind`: `image`, `region` or `edge`.
- **Claim** — a region or an edge. The sheet that drew it **owns** it. Two
  sheets may disagree; that is the point.
- **Region** — a rectangle on an image. Stored as **fractions** of the
  image's rectangle: `fx, fy, fw, fh` in `0..1`. Has a `label` and
  properties.
- **Edge** — a typed connection between two images or regions:
  `relation`, `direction` (`none | forward | reverse | both`), properties.
- **Fraction** — the fact about where a region is. Pixels are derived from
  the image's *current* rectangle every time they are drawn.
- **Snapshot** — a sheet's persisted scene. Written by the server after the
  room goes quiet; merged by element version, so a stale client cannot
  roll back a newer save.
- **Projection** — the server turning a snapshot into **rows**: one row per
  live region, one per live edge. Rows are how the board and other sheets
  learn a claim. Seconds of lag, by design.
- **Foreign** — a claim from another sheet, seen on a sheet that holds the
  same image. Read-only. Drawn on the **overlay**, never in the native
  scene. Can be jumped to (its sheet) or **copied** (becomes your own).
- **Overlay** — our layer above the native canvas that draws foreign
  claims and handles its own pointer events. What is on the overlay is
  never an element.
- **Dangling** — an edge whose end is gone (image missing, foreign region
  deleted). Tolerated, shown, removed only by a person.

## The union

A board's graph is the union of its sheets' claims, each tagged with the
sheet that made it. The board never writes a claim.

## Making sense

- **Term** — a region's label or an edge's relation, as typed.
- **Vocabulary** — a board's terms of one kind (labels, relations), each
  with how many claims use it. Read from rows; never stored as its own
  list. Every label and relation field suggests from it, most-used first.
- **Alias** — a board-level statement that one term means another:
  "same location" → "same place". The target is the **canonical** term.
  Applied wherever claims are READ (vocabulary, find, explore, emphasis);
  never written into a sheet's scene, because the sheet owns its claims.
  Removing an alias restores the term; nothing was rewritten.
- **Confidence** — how sure an edge's sheet is of it: `confirmed`,
  `likely` or `unverified`. Absent means nobody said.
- **Note** — an edge's free text: why the connection holds.
- **Evidence** — an edge's two ends shown side by side: the crops of its
  regions, or the images when an end is a whole image.
- **Comparison** — the two ends opened in one view to check the claim:
  side by side, swiped, or overlaid (with a difference blend). One zoom
  drives both, in units of each end's region.
- **Stamp** — who did something to a claim and when: `made` when it was
  drawn, `edited` at its last change. Written by the client of the person
  signed in; a claim drawn before stamps has none. Not yet checked by the
  server against the socket's user.
- **Reach** — an edge from another sheet with exactly one end on this
  sheet. Drawn on the overlay as a stub leading off the image, never in
  the scene. Bringing its far image onto the sheet turns it into an
  ordinary foreign edge.
- **Pair** — two images, unordered. Every edge joins one pair, whatever
  regions its ends are bound to.
- **Agreement / disagreement** — edges from different sheets on the same
  pair agree when their canonical relations match and their directions do
  not oppose; otherwise they disagree. Shown, never resolved by the
  system.

## Work behind the map

- **Job** — one unit of background work in `jobs`: `ladder`,
  `rank-rebuild` or `materialise`. Claimed by a worker, deleted when done.
- **Lease** — how long a claimed job belongs to its worker. Renewed while
  the job runs. An expired lease means the worker died: the job returns to
  the queue as a spent attempt, and ends `failed` when attempts run out.
- **Worker process** — the worker runs as a child of the server by
  default, so image work that exhausts memory takes down the worker and
  never the API. It **retires** (finishes its batch, exits cleanly) past a
  memory or job bound, and the server starts a new one.
- **Embedding** — what an image means to a CLIP model: a 512-number vector
  (`image_embeddings`, pgvector `halfvec`), computed by the worker when
  `EMBEDDINGS=on`. **Similar** and **search** return images by meaning, as
  ranks under the viewer's sort, the same shape as find.
- **Folder import** — a board filled from a folder on the server's disk,
  under a root the operator allowed (`IMPORT_ROOTS`). Each file takes the
  upload path; the import keeps its file list and a cursor, so it resumes.
- **Invalidation** — a message that one process's cached copy of a board
  (ladder pages, composed tiles, coarse tiles) is old. Published on one
  Postgres channel; every other process drops its copy.
