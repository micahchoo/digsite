# @digsite/server

## Run
```
bun run db:up      # from app/, starts digsite-db
cd server
bun run migrate     # applies migrations/*.sql, idempotent
bun run dev          # bun --watch, port 8800 (or $PORT); starts the worker in-process
bun run worker        # the worker alone, no HTTP server (WORKER=off disables the in-process one)
bun run seed            # dev fixture, needs the server running, refuses if NODE_ENV=production
bun test                  # needs digsite-db, no server needed
bun run check              # tsc --noEmit
```
`PORT` overrides the bound port; `HOST` (127.0.0.1 by default — never `0.0.0.0`
except behind compose) is the bind address. `SERVER_ORIGIN` follows PORT
unless `PUBLIC_ORIGIN` is set (behind a reverse proxy, where the real,
externally-visible origin has no port) — see `src/env.ts`. `WORKER_CONCURRENCY`
(4) sizes the job poller only; the PNG-encode pool is sized off CPU count.
`MATERIALISE_BUDGET_MB` (2048) and `COARSE_BUDGET_MB` (1024) bound the
scatter's tiles and the resident cache. `STORAGE` (`fs` or `s3`,
`src/storage/`) picks where originals, previews, ladder pages and
materialised tiles live — see that directory and the root `README.md`'s
deploy section. `GET /healthz`/`GET /readyz` (`src/health.ts`) are public.
`GET /metrics` (Prometheus text, `src/metrics.ts`) is 404 unless
`METRICS_TOKEN` is set, then gated by it (query `?token=` or `Bearer`) —
request counts/latency per route, tile cache counters, worker queue depth,
sheet rooms/peers.

## Module map
- `src/auth.ts` — Better Auth + organization plugin, `member` widened to
  manage teams — see `.claude/rules/access-one-function-per-intent.md`.
  `minPasswordLength` 10; `session.expiresIn`/`updateAge` from env;
  `rateLimit` tuned but left enabled-in-production-only, Better Auth's own
  default (forcing it on would rate-limit the test suite's own sign-ups).
- `src/db/` — `pool.ts`, `migrate.ts`, `migrations/0001..0008*.sql`
  (`0008` adds `jobs.last_error` and a `(boardId, state)` index).
- `src/access/index.ts` — one function per intent; the only reader of
  `member`/`team`/`teamMember`. `src/http.ts` — the router (`routes()`
  lists every registered route, read-only, for `routes-audit.test.ts`:
  every route 401s unauthenticated and 403s as an outsider except a short,
  individually-commented public/exception list — a new route with neither
  fails the build). `src/app.ts` wires routes + Better Auth + tus +
  Socket.IO into one unstarted server. `src/logging.ts` — one JSON line
  per request (`X-Request-Id`, route, status, ms, user id); a 500 never
  leaks a stack. `src/limits.ts` — a token bucket per (user, action):
  uploads 120/min, tus creates 20/min, socket connects 30/min, scene
  emits 30/s, env-tunable — `429 {reason, retryAfter}` + `Retry-After`,
  or on the socket `limited {reason}` then drop.
- `src/storage/` — the `Storage` port (`put`/`get`/`exists`/`delete`,
  `index.ts`) and its two adapters, `fs.ts` (today's `DATA_DIR` layout,
  byte-for-byte) and `s3.ts` (any S3-compatible endpoint, path-style).
  `lock.ts` is the per-key async lock a page's read-modify-write needs.
  `boards/paths.ts` builds the keys, shared by `upload.ts` and the worker.
  `upload.ts#uploadOne` — hash, store, insert `pending`, enqueue the
  `ladder` job; both the multipart route and tus's `onUploadFinish` call
  it, both after `boards/validate.ts` passes: real type by magic bytes
  (415), size (`UPLOAD_MAX_MB`, 413), pixel budget from the header before
  decode (`UPLOAD_MAX_PIXELS`, 413).
- `boards/tus.ts` — `@tus/server` + `@tus/file-store` at
  `/boards/:id/uploads`(`/*`); `onIncomingRequest` gates on
  `boardForUploading` and the tus-create limit. Never waits for the
  ladder job (only the multipart route does, up to 10s, `?wait=0` skips it).
- `worker/index.ts` — claim (`FOR UPDATE SKIP LOCKED`)/retry/fail. A
  `DecodeError` (worker/jobs.ts, `decodeWithTimeout`/`DECODE_TIMEOUT_MS`)
  gets no backoff (3 attempts, deterministic); anything else backs off
  1s/10s/60s before dead-lettering on the 4th, `last_error` kept — listed
  by `GET /boards/:id/jobs?state=failed`, reset by `POST /jobs/:id/retry`,
  both under `boardForManagingAllowlist`. `worker/jobs.ts` — `ladder`,
  `rank-rebuild` (debounced 2s/board), `materialise`. Tests use `drain()`.
  `worker/tile-encode-worker.ts` — a Bun `Worker` PNG-encoding one tile.
- `boards/ladder.ts` — pages, per-page lock, LRU by `LADDER_BUDGET_MB`.
  `ranks.ts` — rank tables rebuilt whole. `tiles.ts` — compose, the 64 MB
  cache, `coarse-cache.ts`'s resident map (`X-Cache: resident`), then
  disk, then compose; every hit feeds `metrics.ts#recordTileCache`.
  `materialise.ts` — one sort's z ≤ -3 tiles. `sections.ts` — boundary-rank
  grouping.
- `sheets/room.ts` / `snapshot.ts` — the Socket.IO room, merge + project,
  presence and `peers` (`roomCounts()` feeds metrics); a socket past its
  connect or scene-emit limit gets `limited {reason}` then drops.
  `sheets/routes.ts`, `sheets/neighbourhood.ts`. `src/seed.ts` — dev
  fixture via the API.

## Known deviation
The tile curl check expects "four painted cells" at
`tiles/uploaded_at.desc/0/0/0.png`; `COLS=1024` needs ≥ 1026 images for a
second row and the 60-image seed reaches two — see `tiles.test.ts`'s header.
