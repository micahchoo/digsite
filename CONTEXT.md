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
- **Rank** — an image's position under one sort: `0..N-1`. Materialised per
  `(board, sort)` as a table, rebuilt whole, never patched.
- **Cell** — where a rank sits on the map: fixed 128-unit squares, 1024 per
  row, row-major. `col = rank % 1024`, `row = rank / 1024`.
- **Tile** — a 256 px PNG of the cells in one square of the map at one
  **zoom** `z ∈ {0..−5}`. Composed on request from the ladder, cached.
- **Missing** — an image whose original is gone. Kept as a row, shown as
  such, never deleted by the system.

## The sheet is a document

- **Sheet** — a permanent, named document under a board, holding up to 150
  of the board's images, hand-arranged, edited live by several people.
  One Excalidraw scene. Inherits its board's access. Discord's "thread".
- **Element** — an Excalidraw element in a sheet's scene. Every element the
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
  same image. Read-only. Drawn on the **overlay**, never in the Excalidraw
  scene. Can be jumped to (its sheet) or **copied** (becomes your own).
- **Overlay** — our layer above the Excalidraw canvas that draws foreign
  claims and handles its own pointer events. What is on the overlay is
  never an element.
- **Dangling** — an edge whose end is gone (image missing, foreign region
  deleted). Tolerated, shown, removed only by a person.

## The union

A board's graph is the union of its sheets' claims, each tagged with the
sheet that made it. The board never writes a claim.
