// One Pool for the whole server. Every module that touches Postgres imports
// this. One exception constructs its own: sheets/room.ts gives the
// Socket.IO adapter a small pool, because the adapter holds a connection
// for its LISTEN for the life of the server and must not starve this one.
import { Pool } from 'pg';
import { env } from '../env.ts';

export const pool = new Pool({ connectionString: env.DATABASE_URL });
