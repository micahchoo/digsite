// Applies migrations/*.sql in name order, once each, recorded in
// schema_migrations. Safe to rerun: an already-applied file is skipped.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../env.ts';
import { pool } from './pool.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'migrations');

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rows } = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE name = $1',
      [file],
    );
    if (rows.length > 0) {
      console.log(`skip ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
        file,
      ]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${err}`);
    } finally {
      client.release();
    }
  }

  console.log('migrations up to date');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
