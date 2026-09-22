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
`src/env.ts`. `WORKER_CONCURRENCY` (4) sizes the job poller only; the
PNG-encode pool is sized off CPU count. `MATERIALISE_BUDGET_MB` (2048) and
`COARSE_BUDGET_MB` (1024) bound the scatter's tiles and the resident cache.
`STORAGE` (`fs` or `s3`, `src/storage/`) picks where originals, previews,
ladder pages and materialised tiles live — see that directory and the root
`README.md`'s deploy section. `GET /healthz`/`GET /readyz` (`src/health.ts`)
are public and used by `deploy/docker-compose.yml`'s healthchecks.

## Module map
- `src/auth.ts` — Better Auth + organization plugin, `member` widened to
  manage teams — see `.claude/rules/access-one-function-per-intent.md`.
- `src/db/` — `pool.ts`, `migrate.ts`, `migrations/0001_auth.sql`,
  `0002_domain.sql`, `0003_phase1.sql` (`images.status`/`error`, `jobs`,
  `board_rank_state.materialised_at`), `0004_ranks_no_fk.sql` (drops
  `board_ranks`' FK — the ~4s/M-row trigger cost — enforced in `ranks.ts`).
- `src/access/index.ts` — one function per intent; the only reader of
  `member`/`team`/`teamMember`. `src/http.ts` — the router; `src/app.ts`
  wires routes + Better Auth + tus + Socket.IO into one unstarted server.
- `src/storage/` — the `Storage` port (`put`/`get`/`exists`/`delete`,
  `index.ts`) and its two adapters, `fs.ts` (today's `DATA_DIR` layout,
  byte-for-byte) and `s3.ts` (any S3-compatible endpoint, path-style).
  `lock.ts` is the per-key async lock a page's read-modify-write needs —
  the only thing preventing a lost update once a write is a `put` to S3
  rather than an in-place file edit. `boards/paths.ts` builds the keys
  (originals, previews), shared by `upload.ts` and the worker so they
  don't import each other. `upload.ts#uploadOne` — hash, store, insert
  `pending`, enqueue the `ladder` job; both the multipart route and tus's
  `onUploadFinish` call it.
- `boards/tus.ts` — `@tus/server` + `@tus/file-store` at
  `/boards/:id/uploads`(`/*`); `onIncomingRequest` gates on
  `boardForUploading`, `onUploadFinish` calls `uploadOne`. Never waits for
  the ladder job (only the multipart route does — below).
- `worker/index.ts` — claim (`FOR UPDATE SKIP LOCKED`)/retry/fail; no job
  semantics. `worker/jobs.ts` — `ladder`, `rank-rebuild` (debounced
  2s/board), `materialise` (see `boards/materialise.ts`). No retry
  backoff; 3 attempts then `failed`. Tests use `drain()`.
  `worker/tile-encode-worker.ts` — a Bun `Worker` (OS thread) PNG-encoding
  one tile; unrelated to the `jobs` table despite the directory.
- `boards/ladder.ts` — pages, per-page lock, LRU by `LADDER_BUDGET_MB`.
  `ranks.ts` — rank tables rebuilt whole (`board_ranks.board_id` has no
  FK — see `0004`, enforced here). `tiles.ts` — compose (a pending slot
  paints `#333`, not cached), the 64 MB cache, `coarse-cache.ts`'s
  resident map (`X-Cache: resident`), then disk, then compose.
  `materialise.ts` — one sort's z ≤ -3 tiles: one query for the ranks, one
  pass scattering each ladder page once into every tile it touches, PNG
  encoding on a CPU-sized `tile-encode-worker.ts` pool. Reuses one source
  canvas per pass (see `paintPageDirect`'s header comment; a fresh one per
  page OOMs at scale). `sections.ts` — boundary-rank grouping for
  `GET /boards/:id/sections`.
- `sheets/room.ts` / `snapshot.ts` — the Socket.IO room, merge + project,
  presence and named `peers`. `sheets/routes.ts` — sheet list stats,
  rename, `positions`. `sheets/neighbourhood.ts` — a recursive CTE over
  `edges`, capped at `SHEET_LIMIT`; ring layout in
  `@digsite/shared/sheet/layout.ts`. `sheets/rows.ts` — regions/edges
  tables to wire shape, shared by `routes.ts`/`neighbourhood.ts`.
  `src/seed.ts` — dev fixture via the API. `scripts/tus-upload.ts` /
  `presence-smoke.ts` — manual checks for the tus path and the pointer
  relay's 20/s cap.

`POST /boards/:id/images` responds `202`, waiting by default (up to 10s,
`?wait=0` skips it) for the images to leave `pending`. tus never waits.

## Known deviation
The tile curl check expects "four painted cells" at
`tiles/uploaded_at.desc/0/0/0.png`; `COLS=1024` needs ≥ 1026 images for a
second row and the 60-image seed reaches two — see `tiles.test.ts`'s header.

## Phase 3 (groups people can live in)
Four new intents (`groupForManagingMembers`, `boardForDeleting`, `sheetForDeleting`, `imageForDeleting`) plus `0005_delete_indexes.sql`.
Groups: invite links (return `url`), a public invitation preview, pending list/revoke, role/removal, leave — the plugin refuses a sole owner leaving or a non-owner touching an owner role; this layer translates its `APIError` to `{reason}`.
Boards (additive, tile route untouched): rename, delete + footprint, allowlist read/manage, `ids=`/`rank` on `.../images`, `.../relations`, `DELETE /images/:id` (sha256-dedupes before unlinking).
Sheets: delete + footprint.
Stub-vs-doc: invite's `email` stayed required, not `{email?}` — accepting checks it against the invited session's email.
