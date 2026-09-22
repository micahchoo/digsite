# @digsite/server

## Run
```
bun run db:up      # from app/, starts digsite-db
cd server
bun run migrate     # applies migrations/*.sql, idempotent
bun run dev          # bun --watch, port 8800 (or $PORT); starts the worker in-process
bun run worker        # the worker alone, no HTTP server (WORKER=off disables the in-process one)
bun run seed            # dev fixture, needs the server running
bun test                  # 8 files, needs digsite-db, no server needed
bun run check              # tsc --noEmit
```
`PORT` overrides the bound port; `SERVER_ORIGIN` follows it — see
`src/env.ts`. `WORKER_CONCURRENCY` (default 4) sizes the job poller and
materialise's tile-compose pool.

## Module map
- `src/auth.ts` — Better Auth + organization plugin, `member` widened to
  manage teams — see `.claude/rules/access-one-function-per-intent.md`.
- `src/db/` — `pool.ts`, `migrate.ts`, `migrations/0001_auth.sql`,
  `0002_domain.sql`, `0003_phase1.sql` (`images.status`/`error`, `jobs`,
  `board_rank_state.materialised_at`).
- `src/access/index.ts` — one function per intent; the only reader of
  `member`/`team`/`teamMember`. `src/http.ts` — the router; `src/app.ts`
  wires routes + Better Auth + tus + Socket.IO into one unstarted server.
- `boards/paths.ts` — the original's on-disk path, shared by `upload.ts`
  and the worker so they don't import each other. `upload.ts#uploadOne` —
  hash, store, insert `pending`, enqueue the `ladder` job; both the
  multipart route and tus's `onUploadFinish` call it.
- `boards/tus.ts` — `@tus/server` + `@tus/file-store` at
  `/boards/:id/uploads`(`/*`); `onIncomingRequest` gates on
  `boardForUploading`, `onUploadFinish` calls `uploadOne`. Never waits for
  the ladder job (only the multipart route does — below).
- `worker/index.ts` — claim (`FOR UPDATE SKIP LOCKED`)/retry/fail; no job
  semantics. `worker/jobs.ts` — `ladder` (decode, cap 4096, paint,
  `ready`), `rank-rebuild` (debounced 2s/board, every ranked sort),
  `materialise` (z ≤ -3 to disk). No retry backoff (deterministic
  failures); 3 attempts then `failed` + reason. Tests use `drain()`.
- `boards/ladder.ts` — pages, per-page lock, LRU by `LADDER_BUDGET_MB`,
  `preloadPages`. `ranks.ts` — rank tables rebuilt whole
  (`forceRebuildRank` skips the staleness check). `tiles.ts` — compose (a
  pending slot paints `#333`, not cached), the 64 MB cache, and a
  materialised file (`X-Cache: disk`) ahead of composing. `materialise.ts`
  — one sort's z ≤ -3 tiles, `WORKER_CONCURRENCY` parallel. `sections.ts`
  — one query's boundary-rank grouping for `GET /boards/:id/sections`.
- `sheets/room.ts` / `snapshot.ts` — the Socket.IO room, merge + project,
  presence (`pointer`, rate-limited to 20/s per socket server-side, never
  persisted) and named `peers`. `sheets/routes.ts` — sheet list stats
  (`imageCount`/`savedAt`), `PATCH /sheets/:id` rename, `POST
  /boards/:id/sheets`'s optional `positions`. `sheets/neighbourhood.ts` —
  `GET /boards/:id/neighbourhood`, a recursive CTE over `edges` in both
  directions, capped nearest-first at `SHEET_LIMIT`
  (`@digsite/shared/sheet/elements`); ring layout for the result lives in
  `@digsite/shared/sheet/layout.ts` (`ringLayout`). `sheets/rows.ts` — the
  regions/edges tables' own shape converted to the wire shape, shared by
  `routes.ts` and `neighbourhood.ts`. `src/seed.ts` — dev fixture via the
  API. `scripts/tus-upload.ts` — a resumable upload via `tus-js-client`, to
  check the tus path by hand. `scripts/presence-smoke.ts` — two
  `socket.io-client`s in one sheet room, to check the pointer relay and its
  20/s cap by hand.

`POST /boards/:id/images` responds `202`, waiting by default (up to 10s,
`?wait=0` skips it) for the images it enqueued to leave `pending`. tus
uploads never wait.

## Known deviation
The tile curl check expects "four painted cells" at
`tiles/uploaded_at.desc/0/0/0.png`. `COLS=1024` means that tile's second
row needs rank ≥ 1024, i.e. ≥ 1026 images; the 60-image seed reaches two.
Verified live: cells 0/1 painted, 2/3 correctly blank. See
`src/test/tiles.test.ts`'s header comment.
