// GET /healthz (process up) and GET /readyz (DB reachable, storage
// reachable, migrations current) — docs/phases/4-deploy.md section 5, used
// by deploy/docker-compose.yml's healthchecks. Both public (no session
// check) and cheap: readyz's three probes are a `SELECT 1`, one
// Storage.exists() call (a HEAD under s3, a stat under fs — see
// storage/fs.ts and storage/s3.ts), and a migrations-file-vs-
// schema_migrations diff, not full queries against product tables.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db/pool.ts';
import { type Router, json } from './http.ts';
import { storageFromEnv } from './storage/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'db/migrations');

/** Every migrations/*.sql file has a row in schema_migrations — the same
 * "applied once, in order" ledger db/migrate.ts writes. False (never
 * throws) if the table itself doesn't exist yet, i.e. migrate has never
 * run — a real "not ready", not an error. */
async function migrationsCurrent(): Promise<boolean> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  if (files.length === 0) return true;
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name as string));
  return files.every((f) => applied.has(f));
}

export function registerHealthRoutes(router: Router): void {
  router.get('/healthz', async (ctx) => {
    json(ctx.res, 200, { ok: true });
  });

  router.get('/readyz', async (ctx) => {
    const checks = { db: false, storage: false, migrations: false };

    try {
      await pool.query('SELECT 1');
      checks.db = true;
    } catch {
      // checks.db stays false
    }

    try {
      // Existence of a key that (almost certainly) doesn't exist: this
      // only has to prove the backend answers, not that any real object
      // is there. fs.ts's exists() is a sync stat; s3.ts's is a HEAD —
      // either way, a network-down or bad-credentials S3 throws past the
      // adapter's own 404 handling, which is exactly what should flip
      // this to false.
      await storageFromEnv().exists('__readyz_probe__');
      checks.storage = true;
    } catch {
      // checks.storage stays false
    }

    try {
      checks.migrations = await migrationsCurrent();
    } catch {
      // checks.migrations stays false
    }

    const ready = checks.db && checks.storage && checks.migrations;
    json(ctx.res, ready ? 200 : 503, { ready, checks });
  });
}
