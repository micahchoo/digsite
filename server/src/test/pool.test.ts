import { describe, expect, test } from 'bun:test';
// db/pool.ts under a database restart: every pooled connection dies. With
// no 'error' listener on the pool, an idle client's error could end the
// process; measured 2026-09-23 under Bun, it does not — pg drops the client
// and the next query connects afresh. This keeps it that way, because the
// server is expected to ride out a database restart.
import { Client } from 'pg';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';

describe('pool', () => {
  test('an idle connection killed by the database does not end the process', async () => {
    const { rows } = await pool.query('SELECT pg_backend_pid() AS pid');
    const killer = new Client({ connectionString: env.DATABASE_URL });
    await killer.connect();
    await killer.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
    await killer.end();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const again = await pool.query('SELECT 1 AS ok');
    expect(again.rows[0].ok).toBe(1);
  });
});
