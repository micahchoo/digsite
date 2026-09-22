// A per-key async lock: two callers touching the same key must not race a
// read-modify-write. Moved here from boards/ladder.ts (phase 1) because a
// page's read-modify-write is the storage's concern, not the ladder's — and
// because it is now the ONLY thing preventing a lost update on S3 (there is
// no append there: two concurrent `put`s to the same key just leave
// whichever finished last, silently dropping the other's edit). In-process
// only — it does not coordinate two server processes — which matches this
// phase's single-server deployment (deploy/docker-compose.yml runs one
// `server` container).
const locks = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  locks.set(
    key,
    run.catch(() => {}),
  );
  return run;
}
