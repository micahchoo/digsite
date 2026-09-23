// A per-key lock around a read-modify-write of one stored object: two
// callers touching the same key must not race. It is the ONLY thing
// preventing a lost update on S3 (no append there: two concurrent `put`s to
// one key leave whichever finished last, silently dropping the other edit).
//
// Two layers. Callers in one process queue on a promise chain, so they
// never contend for a database connection. The head of that queue then
// takes a Postgres advisory lock on the key, which is what holds across
// processes: the server's worker runs as its own process by default
// (worker/supervisor.ts), and more than one worker may run at once.
import { pool } from '../db/pool.ts';

const locks = new Map<string, Promise<unknown>>();

async function acrossProcesses<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const id = `storage:${key}`;
  let broken = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
      id,
    ]);
    try {
      return await fn();
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [id])
        .catch(() => {
          // A session lock outlives a returned client. Destroying the
          // connection is the only certain way to let it go.
          broken = true;
        });
    }
  } finally {
    client.release(broken);
  }
}

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  const next = () => acrossProcesses(key, fn);
  const run = prior.then(next, next);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  // Forget the key once nothing is queued behind this caller, so the map
  // holds only keys in use, not every page ever painted.
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}
