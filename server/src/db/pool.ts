// One Pool for the whole server. Every module that touches Postgres imports
// this; nothing else constructs a `pg.Pool`.
import { Pool } from 'pg';
import { env } from '../env.ts';

export const pool = new Pool({ connectionString: env.DATABASE_URL });
