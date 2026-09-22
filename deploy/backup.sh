#!/usr/bin/env bash
# Backs up a running digsite deploy: pg_dump (via `docker exec` — the
# postgres client tools live in the db container, not on the host) plus
# either a tar of DATA_DIR (STORAGE=fs) or an `mc mirror` of the S3 bucket
# (STORAGE=s3). Writes a dated directory so nothing is ever overwritten.
#
# Usage:
#   PG_CONTAINER=<name> POSTGRES_USER=<user> POSTGRES_DB=<db> \
#   STORAGE=fs|s3 [DATA_DIR=<path>] [S3_ENDPOINT=... S3_BUCKET=... \
#   S3_ACCESS_KEY=... S3_SECRET_KEY=...] \
#     ./backup.sh <backup-dir>
#
# Defaults match deploy/docker-compose.yml and .env.production.example.
# Prints the new backup's path (<backup-dir>/<UTC timestamp>) on its last
# line, so a caller (deploy/restore.sh's own tests, cron) can capture it.
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-digsite-postgres}"
POSTGRES_USER="${POSTGRES_USER:-digsite}"
POSTGRES_DB="${POSTGRES_DB:-digsite}"
STORAGE="${STORAGE:-fs}"
OUT_DIR="${1:?usage: backup.sh <backup-dir>}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$OUT_DIR/$STAMP"
mkdir -p "$DEST"

echo "backup: db ($POSTGRES_DB on $PG_CONTAINER) -> $DEST/db.sql.gz" >&2
docker exec "$PG_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  | gzip > "$DEST/db.sql.gz"

if [ "$STORAGE" = "s3" ]; then
  : "${S3_ENDPOINT:?S3_ENDPOINT required when STORAGE=s3}"
  : "${S3_BUCKET:?S3_BUCKET required when STORAGE=s3}"
  : "${S3_ACCESS_KEY:?S3_ACCESS_KEY required when STORAGE=s3}"
  : "${S3_SECRET_KEY:?S3_SECRET_KEY required when STORAGE=s3}"
  echo "backup: storage (s3 bucket $S3_BUCKET) -> $DEST/storage/" >&2
  mkdir -p "$DEST/storage"
  # --network host: S3_ENDPOINT is whatever the server's own env names
  # (127.0.0.1:9100 in dev, an internal or external URL in production) —
  # reusing that value here, rather than a container network trick, keeps
  # backup.sh needing to know nothing about how minio/the bucket is wired.
  docker run --rm --network host \
    -v "$DEST/storage:/backup" \
    quay.io/minio/mc:latest \
    sh -c "mc alias set src '$S3_ENDPOINT' '$S3_ACCESS_KEY' '$S3_SECRET_KEY' && mc mirror --quiet src/$S3_BUCKET /backup"
else
  : "${DATA_DIR:?DATA_DIR required when STORAGE=fs}"
  echo "backup: storage (fs $DATA_DIR) -> $DEST/storage.tar.gz" >&2
  tar -C "$DATA_DIR" -czf "$DEST/storage.tar.gz" .
fi

echo "backup complete: $DEST" >&2
echo "$DEST"
