// docs/phases/4-deploy.md "Tests": the Storage interface contract
// (storage/index.ts) against fs (storage/fs.ts, always) and, when
// S3_ENDPOINT is set, against s3 (storage/s3.ts, minio locally) — same
// four assertions run against both adapters, plus the per-page lock
// (storage/lock.ts) losing nothing under a concurrent read-modify-write,
// which is what makes a lost update on S3 (no append there — see
// boards/ladder.ts#paintLadder) impossible.
//
// Run against minio: `bun run infra:up` from the repo root (brings up the
// `s3` compose profile alongside `db`), then
// `S3_ENDPOINT=http://127.0.0.1:9100 S3_BUCKET=digsite S3_ACCESS_KEY=digsite S3_SECRET_KEY=digsite-secret bun test storage.test.ts`
// (or `bun test`, which runs every file — see server/README.md).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Storage,
  makeFsStorage,
  makeS3Storage,
} from '../storage/index.ts';
import { withLock } from '../storage/lock.ts';

function contract(name: string, make: () => Storage): void {
  describe(`storage (${name})`, () => {
    test('put then get round-trips exact bytes', async () => {
      const storage = make();
      const key = `contract/${name}/${Date.now()}-roundtrip`;
      const body = new TextEncoder().encode('hello storage');
      await storage.put(key, body, 'text/plain');
      const got = await storage.get(key);
      expect(got && Buffer.from(got).toString('utf8')).toBe('hello storage');
    });

    test('get on a key that was never written returns null, not a throw', async () => {
      const storage = make();
      const got = await storage.get(
        `contract/${name}/never-written-${Date.now()}`,
      );
      expect(got).toBeNull();
    });

    test('exists reflects put and delete', async () => {
      const storage = make();
      const key = `contract/${name}/${Date.now()}-exists`;
      expect(await storage.exists(key)).toBe(false);
      await storage.put(
        key,
        new Uint8Array([1, 2, 3]),
        'application/octet-stream',
      );
      expect(await storage.exists(key)).toBe(true);
      await storage.delete(key);
      expect(await storage.exists(key)).toBe(false);
    });

    test('delete on a key that was never written does not throw', async () => {
      const storage = make();
      await storage.delete(
        `contract/${name}/delete-never-written-${Date.now()}`,
      );
    });

    test('put overwrites an existing key in place', async () => {
      const storage = make();
      const key = `contract/${name}/${Date.now()}-overwrite`;
      await storage.put(key, new TextEncoder().encode('first'), 'text/plain');
      await storage.put(key, new TextEncoder().encode('second'), 'text/plain');
      const got = await storage.get(key);
      expect(got && Buffer.from(got).toString('utf8')).toBe('second');
    });

    // boards/ladder.ts#paintLadder's own shape: read the page, draw one
    // more slot, write the page back — under storage/lock.ts#withLock so
    // two uploads landing on the same page (or, here, 20 concurrent
    // increments of the same key) don't race a lost update. This is what
    // "PR docs/phases/4-deploy.md section 1" means by "the per-page lock
    // ... is now the only thing preventing a lost update on S3".
    test('a concurrent read-modify-write to one key, under the lock, loses nothing', async () => {
      const storage = make();
      const key = `contract/${name}/${Date.now()}-lock`;
      await storage.put(key, new Uint8Array([0]), 'application/octet-stream');

      const increments = 20;
      await Promise.all(
        Array.from({ length: increments }, () =>
          withLock(key, async () => {
            const cur = await storage.get(key);
            const n = cur ? (cur[0] ?? 0) : 0;
            await storage.put(
              key,
              new Uint8Array([n + 1]),
              'application/octet-stream',
            );
          }),
        ),
      );

      const final = await storage.get(key);
      expect(final?.[0]).toBe(increments);
    });

    // The negative case: the SAME read-modify-write, WITHOUT the lock,
    // demonstrably loses updates — proves the test above is measuring the
    // lock and not something else (retries, adapter-level atomicity, S3's
    // own last-writer-wins). If this ever stops losing updates on its own,
    // the positive test above stops meaning anything.
    test('the same read-modify-write WITHOUT the lock loses updates', async () => {
      const storage = make();
      const key = `contract/${name}/${Date.now()}-no-lock`;
      await storage.put(key, new Uint8Array([0]), 'application/octet-stream');

      const increments = 20;
      await Promise.all(
        Array.from({ length: increments }, async () => {
          const cur = await storage.get(key);
          const n = cur ? (cur[0] ?? 0) : 0;
          await storage.put(
            key,
            new Uint8Array([n + 1]),
            'application/octet-stream',
          );
        }),
      );

      const final = await storage.get(key);
      expect(final?.[0]).toBeLessThan(increments);
    });
  });
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'digsite-storage-test-'));
contract('fs', () => makeFsStorage(tmpRoot));

if (process.env.S3_ENDPOINT) {
  contract('s3', () => makeS3Storage());
} else {
  describe('storage (s3)', () => {
    test.skip('S3_ENDPOINT not set — see this file header for how to run against minio', () => {
      // skipped
    });
  });
}
