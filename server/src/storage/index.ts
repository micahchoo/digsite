// The storage port (docs/phases/4-deploy.md section 1): one interface, two
// adapters, chosen by STORAGE=fs|s3. Everything that reads or writes
// originals, previews, ladder pages, tus staging's finished bytes and
// materialised tiles goes through this — boards/paths.ts is now key
// builders only, and every fs call those keys used to feed moved into
// fs.ts. put/get/exists/delete cover every single-key caller; `list` (added
// docs/phases/5-hardening.md section 5) is the fifth method, and the reason
// it earns a place in the interface rather than staying a named export like
// presignedGetUrl: three callers (coarse-cache.ts's disk warm-up,
// materialise.ts's stale-sort clear, boards/routes.ts's board-delete sweep)
// needed "every key under this prefix" on BOTH adapters, which is exactly
// what made those three `env.STORAGE !== 's3'` gates exist — a capability
// only one adapter had. Anything still genuinely adapter-specific (S3's
// presigned URL) stays a named export — see presignedGetUrl below.
export interface Storage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Every key with this prefix, in no particular order. An empty result
   * for a prefix that never existed is not an error — same "absence is
   * quiet" contract as `get`. */
  list(prefix: string): AsyncIterable<string>;
}

import { env } from '../env.ts';
import { FsStorage } from './fs.ts';
import { S3Storage } from './s3.ts';

let instance: Storage | null = null;

/** The process's one Storage, built from STORAGE/DATA_DIR/S3_* on first
 * call and reused after — same pattern as db/pool.ts's one Pool. */
export function storageFromEnv(): Storage {
  if (!instance) {
    instance =
      env.STORAGE === 's3' ? new S3Storage() : new FsStorage(env.DATA_DIR);
  }
  return instance;
}

/** Only meaningful when storageFromEnv() is backed by S3 (STORAGE=s3): a
 * short-lived GET-only URL for `key`, so `GET /images/:id/original` can
 * answer a 302 instead of streaming the bytes through the server
 * (docs/phases/4-deploy.md section 2). Returns null under `fs`, where a
 * redirect target for the browser to fetch directly doesn't exist — the
 * caller falls back to serving the bytes itself. `instanceof` rather than
 * widening the Storage type: the interface above stays exactly four
 * methods every adapter shares. */
export async function presignedGetUrl(
  key: string,
  expiresInSeconds: number,
): Promise<string | null> {
  const storage = storageFromEnv();
  if (!(storage instanceof S3Storage)) return null;
  return storage.presign(key, expiresInSeconds);
}

// Test-only: storage.test.ts runs the same contract against a fresh fs
// adapter (a temp dir) and, when S3_ENDPOINT is set, a fresh s3 adapter —
// neither wants the process-wide singleton above, which is fixed to
// STORAGE at first call.
export function makeFsStorage(root: string): Storage {
  return new FsStorage(root);
}
export function makeS3Storage(): Storage {
  return new S3Storage();
}

/** Deletes every key under `prefix`, batching a bounded number of concurrent
 * `delete` calls rather than either serialising (slow on S3's per-call
 * latency) or firing them all at once (a board's tiles alone are thousands
 * of keys). The three `env.STORAGE !== 's3'` gates this replaces
 * (materialise.ts's stale-sort clear, boards/routes.ts's board-delete
 * sweep) used to be fs-only `rmSync(dir, {recursive: true})` one-liners;
 * this is the adapter-agnostic equivalent, at the cost of one `list` plus
 * N `delete`s instead of one directory unlink. Returns the count deleted,
 * for callers that want to log or assert on it.
 *
 * Under fs, one `pruneEmptyTree` call afterward removes the directories
 * those N deletes left empty — `docs/measurements/phase-5.md`'s load run
 * is why this isn't done per-file inside `delete()` any more: at 500,000
 * images that was ~38,000 individual `readdir`-then-maybe-`rmdir` walks
 * (~45 s per board delete); one post-order walk of `prefix` after the
 * fact is O(directories) instead of O(files). `instanceof FsStorage`
 * rather than a sixth `Storage` interface method — same reasoning as
 * `presignedGetUrl`'s own S3-only capability above: directories are not a
 * concept S3 has. */
export async function deletePrefix(
  storage: Storage,
  prefix: string,
  concurrency = 32,
): Promise<number> {
  let count = 0;
  let batch: string[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await Promise.all(batch.map((key) => storage.delete(key)));
    count += batch.length;
    batch = [];
  };
  for await (const key of storage.list(prefix)) {
    batch.push(key);
    if (batch.length >= concurrency) await flush();
  }
  await flush();
  if (storage instanceof FsStorage) await storage.pruneEmptyTree(prefix);
  return count;
}
