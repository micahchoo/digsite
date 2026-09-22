#!/usr/bin/env bash
# The reverse of backup.sh. Restores one dated backup into a database and a
# storage location. The target database must already exist and be EMPTY —
# this script does not create or drop it (deploy/backup.sh's own docs, and
# e2e/src/backup-restore.ts, `CREATE DATABASE` themselves first) — so a
# typo'd POSTGRES_DB can never restore on top of a live one by accident.
#
# Usage:
#   PG_CONTAINER=<name> POSTGRES_USER=<user> POSTGRES_DB=<empty target db> \
#   STORAGE=fs|s3 [DATA_DIR=<empty target dir>] [S3_ENDPOINT=... \
#   S3_BUCKET=... S3_ACCESS_KEY=... S3_SECRET_KEY=...] \
#     ./restore.sh <backup-dir>/<timestamp>
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-digsite-postgres}"
POSTGRES_USER="${POSTGRES_USER:-digsite}"
POSTGRES_DB="${POSTGRES_DB:-digsite}"
STORAGE="${STORAGE:-fs}"
SRC="${1:?usage: restore.sh <backup-dir>/<timestamp>}"

[ -f "$SRC/db.sql.gz" ] || {
  echo "restore: $SRC/db.sql.gz not found" >&2
  exit 1
}

echo "restore: $SRC/db.sql.gz -> $POSTGRES_DB on $PG_CONTAINER" >&2
gunzip -c "$SRC/db.sql.gz" \
  | docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"

if [ "$STORAGE" = "s3" ]; then
  [ -d "$SRC/storage" ] || {
    echo "restore: $SRC/storage not found" >&2
    exit 1
  }
  : "${S3_ENDPOINT:?S3_ENDPOINT required when STORAGE=s3}"
  : "${S3_BUCKET:?S3_BUCKET required when STORAGE=s3}"
  : "${S3_ACCESS_KEY:?S3_ACCESS_KEY required when STORAGE=s3}"
  : "${S3_SECRET_KEY:?S3_SECRET_KEY required when STORAGE=s3}"
  echo "restore: $SRC/storage/ -> s3 bucket $S3_BUCKET" >&2
  docker run --rm --network host \
    -v "$SRC/storage:/backup" \
    quay.io/minio/mc:latest \
    sh -c "mc alias set dst '$S3_ENDPOINT' '$S3_ACCESS_KEY' '$S3_SECRET_KEY' && mc mb --ignore-existing dst/$S3_BUCKET && mc mirror --quiet /backup dst/$S3_BUCKET"
else
  [ -f "$SRC/storage.tar.gz" ] || {
    echo "restore: $SRC/storage.tar.gz not found" >&2
    exit 1
  }
  : "${DATA_DIR:?DATA_DIR required when STORAGE=fs}"
  if [ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
    echo "restore: DATA_DIR $DATA_DIR is not empty — refusing to restore over live data" >&2
    exit 1
  fi
  mkdir -p "$DATA_DIR"
  echo "restore: $SRC/storage.tar.gz -> $DATA_DIR" >&2
  tar -C "$DATA_DIR" -xzf "$SRC/storage.tar.gz"
fi

echo "restore complete" >&2
