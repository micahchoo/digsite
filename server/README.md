# @digsite/server

## Run
```
bun run db:up      # from app/, starts digsite-db
cd server
bun run migrate     # applies migrations/*.sql, idempotent
bun run dev          # bun --watch, port 8800 (or $PORT)
bun run seed          # dev fixture, needs the server running
bun test               # 5 files, needs digsite-db, no server needed
bun run check            # tsc --noEmit
```
`PORT` overrides the bound port; `SERVER_ORIGIN` (and Better Auth's
`baseURL`) always follow it — see `src/env.ts`.

## Module map
- `src/auth.ts` — Better Auth + organization plugin. `member`'s role is
  widened to create/manage teams (private-board allowlists) — see the
  file's own comment and `.claude/rules/access-one-function-per-intent.md`.
- `src/db/` — `pool.ts`, `migrate.ts`, `migrations/0001_auth.sql` (from
  `bunx @better-auth/cli generate`), `0002_domain.sql`.
- `src/access/index.ts` — one function per intent; the only module that
  reads `member`/`team`/`teamMember`.
- `src/http.ts` — the router; `src/app.ts` wires routes + Better Auth +
  Socket.IO into one unstarted `http.Server` (`index.ts` calls `.listen`;
  tests listen on an ephemeral port).
- `src/groups/`, `src/boards/`, `src/sheets/` — the `routes.ts` per group.
- `boards/ladder.ts` — painted pages, per-page lock, LRU by
  `LADDER_BUDGET_MB`. `ranks.ts` — rank tables, rebuilt whole. `tiles.ts` +
  `tiles-cache.ts` — compose + the 64 MB cache.
- `sheets/room.ts` — the Socket.IO room; `snapshot.ts` — merge + project +
  row replacement, one transaction. `src/seed.ts` — dev fixture via the API.

## Known deviation
The tile curl check expects "four painted cells" at
`tiles/uploaded_at.desc/0/0/0.png`. `COLS=1024` means that tile's second
row needs rank ≥ 1024, i.e. ≥ 1026 images; the 60-image seed reaches two.
Verified live: cells 0/1 painted, 2/3 correctly blank. See
`src/test/tiles.test.ts`'s header comment.
