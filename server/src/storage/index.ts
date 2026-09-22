// The storage port (docs/phases/4-deploy.md section 1): one interface, two
// adapters, chosen by STORAGE=fs|s3. Everything that reads or writes
// originals, previews, ladder pages, tus staging's finished bytes and
// materialised tiles goes through this — boards/paths.ts is now key
// builders only, and every fs call those keys used to feed moved into
// fs.ts. Kept to exactly these four methods: put/get/exists cover every
// caller in this codebase, and delete covers the two places an image or a
// board is removed (boards/routes.ts). Anything an adapter can do that the
// other can't (S3's presigned URL) is its own named export below, not a
// fifth interface method — see presignedGetUrl.
export interface Storage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
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
