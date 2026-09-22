# digsite

A shared, sortable image board with hand-arranged sheets on top.

See `CONTEXT.md` for vocabulary and `docs/design.md` for the full contract.
This file is for running it — locally, or deployed on your own machine.

## Local development

```
cp .env.example .env
bun install
bun run db:up
bun run db:migrate
bun run seed
bun run dev
```

`bun run check` typechecks every workspace, runs Biome, and runs
`scripts/lint-seams.ts`, which fails the build when code crosses one of the
seams in `.claude/rules/`. `bun run infra:up` brings up Postgres and a local
minio (`STORAGE=s3` in `.env`) instead of just Postgres.

## Testing and CI

`bun run test` runs every workspace's unit tests against `bun run db:up`'s
Postgres. `bun run e2e:fresh` is the full walking-skeleton run: it creates
its own `digsite_e2e_<ts>` database and temp data dir on that same
container, migrates, seeds, starts a server and a web dev server on free
ports, runs the scripted suites (`e2e/src/{run,groups-life,sheet-hour}.ts`),
then tears everything down — nothing it does touches your own dev server,
web server or database. `VITE_CANVAS=excalidraw|native` picks the sheet
canvas adapter it exercises. `bun run smoke` runs the five
`web/scripts/smoke*.ts` definition-of-done scripts, each against its own
fresh stub (`web/stub/server.ts`) on free ports — no database needed.
`.github/workflows/ci.yml` runs all three (`check`, `test`, `e2e:fresh`
against both canvases, `smoke`) on push and pull request.

## Deploying

Prerequisites: a Linux machine with Docker and Docker Compose, and a domain
with two DNS records pointing at it — the bare domain and `api.` + that
domain (`deploy/Caddyfile` serves the app at one and the API at the other;
see that file for why it's a subdomain split rather than one origin).

```
git clone <this repo> && cd digsite
cp deploy/.env.production.example deploy/.env
# edit deploy/.env: DOMAIN, POSTGRES_PASSWORD, AUTH_SECRET (openssl rand -hex 32)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

Add `--profile s3` to that last command (and set the `S3_*` variables in
`deploy/.env`) to run against the bundled minio instead of the default
`STORAGE=fs`; point `S3_ENDPOINT` at a real bucket instead to skip minio
entirely. Caddy provisions TLS certificates for both DNS names on its own
the first time it starts — give it a minute before the first visit.

Confirm it's up: `curl https://api.<your domain>/readyz` answers
`{"ready":true,...}`, then `bun run smoke:prod` from a machine with Bun and
Playwright installed:

```
PROD_ORIGIN=https://<your domain> bun run smoke:prod
```

## Variables that matter

| Variable | Meaning |
| --- | --- |
| `DOMAIN` | The app's domain; Caddy serves it and `api.$DOMAIN` |
| `POSTGRES_PASSWORD` | Postgres's own password — pick one, don't reuse |
| `AUTH_SECRET` | Signs sessions; the server refuses to start at the example value |
| `STORAGE` | `fs` (a named volume) or `s3` (any S3-compatible bucket) |
| `S3_ENDPOINT`/`S3_BUCKET`/`S3_ACCESS_KEY`/`S3_SECRET_KEY` | Only read when `STORAGE=s3` |

Everything else (`WORKER_CONCURRENCY`, `LADDER_BUDGET_MB`,
`MATERIALISE_BUDGET_MB`, `COARSE_BUDGET_MB`, `INVITATION_EXPIRES_IN`) is
performance tuning with a working default — see `server/README.md` and
`server/src/env.ts` for what each one bounds.

## Where the data lives

Postgres's own volume (`digsite-postgres`) and, under `STORAGE=fs`, the
`digsite-data` volume — originals, ladder pages and materialised tiles,
under `boards/<id>/...` (`server/src/storage/fs.ts`). Under `STORAGE=s3`,
that same layout lives as keys in your bucket instead, and `digsite-data`
holds only tus's transient upload staging.

## Backing up

```
PG_CONTAINER=digsite-postgres POSTGRES_DB=digsite STORAGE=fs \
  DATA_DIR=<the digsite-data volume's mountpoint> \
  ./deploy/backup.sh ./backups
```

(`STORAGE=s3` needs `S3_ENDPOINT`/`S3_BUCKET`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`
instead of `DATA_DIR` — see the script's own header.) Writes a dated
directory under `./backups`; print a volume's mountpoint with
`docker volume inspect deploy_digsite-data`. `deploy/restore.sh` reverses
it, into a database and a `DATA_DIR` that must both already be empty —
see that script's header. `e2e/src/backup-restore.ts` exercises the whole
round trip against the dev stack (`bun run backup-restore` from `e2e/`).

## Upgrading

```
git pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

The server runs its migrations on every start (`deploy/Dockerfile.server`;
`server/src/db/migrate.ts` skips anything already applied), so this is the
whole upgrade — no separate migrate step. Back up first regardless; a
migration is not designed to be reversible.
