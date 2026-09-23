# Phase 5 — hardening

What makes the product safe to leave running for strangers, plus the
debts phases 1–4 left on purpose. Words: `../../CONTEXT.md`. Every rule
in `../../.claude/rules/` stays binding; `bun run lint:seams` is part of
`bun run check`.

Done when every section's test passes and `docs/measurements/phase-5.md`
records the load numbers.

## 1. Access audit (server)

The seam linter proves no file outside `access/` reads membership; it
does not prove every route calls an intent. Add both halves:
- `server/src/test/routes-audit.test.ts`: enumerate every registered
  route from the `Router` (expose a read-only `routes()` list), call each
  unauthenticated → 401 (except the public list: `/healthz`, `/readyz`,
  `/api/auth/*`, `GET /invitations/:id`), and as `outsider` against Lab's
  objects → 403. A new route with neither fails the build.
- A `checks:` entry in `access-one-function-per-intent.md` requiring each
  `router.<verb>(` block in `server/src/{groups,boards,sheets}/routes.ts`
  to be followed by a call named `*For*(` or listed as public — if a grep
  can't express it cleanly, the audit test is enough; say which.

## 2. Abuse limits (server)

- `server/src/limits.ts`: a token bucket per (user, action), in memory,
  with limits from env: uploads 6000 files/min, tus 600 creates/min,
  socket connects 30/min, scene emits 30/s, sign-in via Better Auth's
  `rateLimit` option. A refusal is `429 {reason, retryAfter}` with a
  `Retry-After` header; on the socket, `limited {reason}` and drop.
- Upload validation in the request and the worker: size cap
  `UPLOAD_MAX_MB` (default 50), content type by magic bytes (PNG, JPEG,
  WebP, GIF, AVIF where `@napi-rs/canvas` decodes it), a pixel budget
  checked from the header before decode (`UPLOAD_MAX_PIXELS`, default
  100 M), decode inside the worker with a timeout. Multipart requests are
  streamed under `UPLOAD_BATCH_MAX_MB` (default 100 MiB) and limited to 100
  files per batch before form parsing or storage. A refused file is
  `415`/`413` in the request or `failed` with a reason in the worker.

## 3. Sessions and exposure (server + web config)

- Cookies `Secure` when `SERVER_ORIGIN` is https, `SameSite=Lax`,
  `HttpOnly`; session lifetime and refresh from env; password minimum 10.
- Dev servers bind `127.0.0.1` by default (`HOST` env for the server,
  `server.host` in `vite.config.ts`); prod binds what compose says.
- `SERVER_ORIGIN` is no longer forced to `PORT`: `PUBLIC_ORIGIN` wins
  when set, so the server behind Caddy knows its real origin.
- `seed.ts` refuses to run when `NODE_ENV=production`.

## 4. Operability (server)

- A request id per request (`X-Request-Id`, generated or passed
  through), structured JSON logs one line per request with route,
  status, ms, user id and the `Server-Timing` parts; errors logged with
  stack and request id; a 500 never leaks a stack to the client.
- `GET /metrics` (Prometheus text, protected by `METRICS_TOKEN`):
  request counts and latency histograms per route, tile cache counters
  by `X-Cache`, ladder/coarse residency bytes, worker queue depth by
  state, socket rooms and peers.
- Worker: retry with exponential backoff (1 s, 10 s, 60 s) for failures
  that are not decode errors; a `failed` job is kept with its reason and
  listed by `GET /boards/:id/jobs?state=failed` under
  `boardForManagingAllowlist`; `POST /jobs/:id/retry` under the same.

## 5. Scale debts (server)

- `board_ranks` partitioned by `board_id` (hash, 16 partitions, or list
  per board — measure both on the 1M board and keep the faster).
  Target: rank rebuild at 1M ≤ 2 s cold.
- Materialisation enforces its own cap: `MATERIALISE_BUDGET_MB` covers
  tile canvases AND decoded pages AND pending PNG buffers, measured by
  the process, refusing loudly before it would exceed; a test proves
  the refusal.
- `Storage` gains `list(prefix): AsyncIterable<string>` on both adapters;
  the coarse cache warms from it under s3, the materialise clear and the
  board-delete sweep use it on both adapters, and the `env.STORAGE !==
  's3'` gates go away.
- The cross-board load run (`server/scripts/load-boards.ts`): 20 boards
  of 500k synthetic images (10M total), each with two sorts built and
  materialised, then 20 simulated viewers panning different boards at
  once for 5 minutes with `LADDER_BUDGET_MB` at the default. Record in
  `docs/measurements/phase-5.md`: tile p50/p95/p99 by zoom and by
  `X-Cache`, ladder evictions per minute, RSS peak, rank rebuild times
  with the partitioned table. Run under
  `systemd-run --user --scope -p MemoryMax=60G`. Disk: check first;
  skip S=128 eager painting if it would exceed 20 % of free space.

## 6. CI and a clean e2e (e2e + repo)

- `scripts/e2e-fresh.ts`: creates a database `digsite_e2e_<ts>` on the
  running container, migrates, seeds, starts server and web on free
  ports with a temp `DATA_DIR`, runs `run.ts`, `groups-life.ts`,
  `sheet-hour.ts` (`HOUR_ACTIONS=60`) with the origins passed by env,
  stops everything, drops the database, deletes the dir, exits non-zero
  on any failure. `bun run e2e:fresh` at the root. With a fresh database
  scenarios 1 and 2 must pass; the debris tolerance in `run.ts` goes.
- `.github/workflows/ci.yml`: bun, a Postgres 16 service, `bun install`,
  `bun run check`, `bun run test`, Playwright browsers, `bun run
  `e2e:fresh` against the native sheet canvas.
