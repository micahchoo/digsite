#!/usr/bin/env bash
# Proves the newest backup restores. Restores it with restore.sh into a
# scratch database (and, for STORAGE=fs, a scratch directory), checks what
# came back, then drops both. Nothing live is read or written: the scratch
# database is created here and never has the live database's name.
#
# What it checks:
#   1. Every table holds as many rows as the dump's COPY blocks carried.
#   2. For a random sample of ready images (DRILL_SAMPLE, default 500),
#      the original and its 128-px ladder page are in the restored
#      storage. This is what fails when the tar or mirror missed files the
#      database refers to.
# It does not start a server. The full walk against a restored copy is
# e2e/src/backup-restore.ts.
#
# For STORAGE=s3 the backup's storage/ is a plain mirror of the bucket, so
# the files are checked there instead of being restored into a bucket.
#
# Usage:
#   PG_CONTAINER=<name> POSTGRES_USER=<user> STORAGE=fs|s3 \
#     ./restore-drill.sh <backup-dir>
# Monthly, e.g. in cron:
#   30 4 1 * * cd /opt/digsite/deploy && ./restore-drill.sh /var/backups/digsite
# Exits non-zero when any check fails; the last line says why.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PG_CONTAINER="${PG_CONTAINER:-digsite-postgres}"
POSTGRES_USER="${POSTGRES_USER:-digsite}"
STORAGE="${STORAGE:-fs}"
DRILL_SAMPLE="${DRILL_SAMPLE:-500}"
OUT_DIR="${1:?usage: restore-drill.sh <backup-dir>}"

SRC="$(find "$OUT_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*T*Z' | sort -r | head -n 1)"
[ -n "$SRC" ] || {
  echo "drill FAILED: no backup under $OUT_DIR" >&2
  exit 1
}
DB="digsite_drill_$(date -u +%Y%m%d%H%M%S)"
SCRATCH="$(mktemp -d)"

psql_on() {
  docker exec -i "$PG_CONTAINER" psql -X -v ON_ERROR_STOP=1 -At -q -U "$POSTGRES_USER" -d "$1" "${@:2}"
}
cleanup() {
  psql_on postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1 || true
  rm -rf -- "$SCRATCH"
}
trap cleanup EXIT
fail() {
  echo "drill FAILED ($SRC): $1" >&2
  exit 1
}

echo "drill: $SRC -> database $DB" >&2
psql_on postgres -c "CREATE DATABASE $DB" >/dev/null
DATA_DIR="$SCRATCH/data"
if [ "$STORAGE" = "s3" ]; then
  # restore.sh would mirror into a bucket; restore the database alone.
  gunzip -c "$SRC/db.sql.gz" | psql_on "$DB" >/dev/null
  FILES="$SRC/storage"
else
  PG_CONTAINER="$PG_CONTAINER" POSTGRES_USER="$POSTGRES_USER" \
    POSTGRES_DB="$DB" STORAGE=fs DATA_DIR="$DATA_DIR" \
    "$HERE/restore.sh" "$SRC" >/dev/null
  FILES="$DATA_DIR"
fi

# 1. Rows: the dump's COPY blocks against the restored tables.
tables=0
while read -r table want; do
  # </dev/null: `docker exec -i` would read the rest of the table list.
  got="$(psql_on "$DB" -c "SELECT count(*) FROM $table" </dev/null)"
  [ "$got" = "$want" ] || fail "$table has $got rows, the dump carried $want"
  tables=$((tables + 1))
done < <(gunzip -c "$SRC/db.sql.gz" | awk '
  /^COPY / { table = $2; n = 0; next }
  table && /^\\\.$/ { print table, n; table = ""; next }
  table { n++ }')
[ "$tables" -gt 0 ] || fail "the dump has no data at all"

# 2. Files: a sample of ready images, their originals and 128-px ladder pages.
images="$(psql_on "$DB" -c "SELECT count(*) FROM images WHERE status = 'ready' AND NOT missing")"
missing=0
checked=0
while IFS='|' read -r board sha slot; do
  checked=$((checked + 1))
  for key in "boards/$board/originals/$sha" "boards/$board/ladder/128/page-$((slot / 16)).png"; do
    [ -f "$FILES/$key" ] || {
      echo "drill: missing $key" >&2
      missing=$((missing + 1))
    }
  done
done < <(psql_on "$DB" -c "SELECT board_id, sha256, slot FROM images
  WHERE status = 'ready' AND NOT missing ORDER BY random() LIMIT $DRILL_SAMPLE")
[ "$missing" -eq 0 ] || fail "$missing of $((checked * 2)) sampled files are not in the backup"

echo "drill passed ($SRC): $tables tables match the dump; $checked of $images images sampled, every original and ladder page present"
