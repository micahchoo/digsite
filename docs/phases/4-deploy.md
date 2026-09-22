# Phase 4 — storage and deployment

Done when a fresh Linux machine with Docker goes from a clone to a
running instance by following `README.md`, and `bun run smoke:prod`
passes against it: sign up, upload, tile, sheet, foreign.

## 1. Object storage (`server/src/storage/`)

One interface, two implementations, chosen by `STORAGE=fs|s3`:

```ts
export interface Storage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
```

Keys: `boards/<id>/originals/<sha256>`,
`boards/<id>/ladder/<S>/page-<n>.png`, `boards/<id>/tiles/<sortId>/<z>/<x>-<y>.png`.
`fs` is today's `DATA_DIR`; `s3` uses the AWS SDK v3 against any
S3-compatible endpoint (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`,
`S3_SECRET_KEY`, `S3_REGION`). The ladder store and materialiser read
through `Storage`; page writes stay under the per-page lock, which is
now the only thing preventing a lost update on S3 (no append there).
The dev compose gets a `minio` service on `127.0.0.1:9100` (console
`9101`) so `s3` can be exercised locally; `bun run db:up` becomes `bun
run infra:up`. Never touch the machine's existing `deploy-minio-1`.

## 2. Serving originals and pages

`GET /images/:id/original` and tile responses stay behind the access
gate; with `s3`, the original is served by a short-lived presigned
redirect (`302`, 5 minutes) so bytes do not pass through the server,
and tiles are still composed or read by the server (they are small and
the gate is per board). `Cache-Control: private, max-age=300` on
originals; tiles keep `max-age=60`.

## 3. Production compose (`deploy/`)

`deploy/docker-compose.yml`: `db` (postgres 16, volume), `minio`
(optional profile), `server` (built from `deploy/Dockerfile.server`:
`oven/bun` image, runs migrations then starts), `web` (static build
served by `caddy`), `caddy` in front of both with automatic TLS from
`DOMAIN`. `.env.production.example` lists every variable with a
one-line meaning. The server image runs `bun run migrate` on start and
refuses to start if `AUTH_SECRET` is the example value.

## 4. Backups and restore

`deploy/backup.sh`: `pg_dump` to a dated file plus an `mc mirror` (or
`tar` for `fs`) of the storage; `deploy/restore.sh` reverses it and is
tested once in CI-like fashion by `e2e/src/backup-restore.ts` against
the dev stack: seed, back up, wipe, restore, smoke.

## 5. Health and readiness

`GET /healthz` (process up) and `GET /readyz` (DB reachable, storage
reachable, migrations current), both public and cheap. The compose
healthchecks use them.

## 6. README

Rewritten for a person deploying: prerequisites, the six commands, the
variables that matter, how to back up, how to upgrade (pull, migrate
runs on start), where the data lives. Under 120 lines; the design
stays in `docs/`.

## Tests

- `storage.test.ts`: the interface contract against `fs` and, when
  `S3_ENDPOINT` is set, against minio: put/get/exists/delete, a
  concurrent page write under the lock loses nothing.
- `e2e/src/backup-restore.ts` as above.
- `bun run smoke:prod` (`e2e/src/smoke-prod.ts`): the five steps against
  `PROD_ORIGIN`.
