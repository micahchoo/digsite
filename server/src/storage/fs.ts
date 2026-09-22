// The `fs` adapter: today's DATA_DIR layout, byte-for-byte — a key is the
// path relative to DATA_DIR, so `boards/<id>/originals/<sha256>` (a
// Storage key, see index.ts) reads and writes exactly
// `${DATA_DIR}/boards/<id>/originals/<sha256>` on disk, the same file an
// unmigrated deployment already has. No key ever needs translating.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Storage } from './index.ts';

export class FsStorage implements Storage {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    return join(this.root, key);
  }

  async put(
    key: string,
    body: Uint8Array,
    _contentType: string,
  ): Promise<void> {
    const path = this.resolve(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    // existsSync, not a stat-and-catch: this is on the tile/preview read
    // path (tiles.ts, boards/routes.ts) and a sync stat is cheaper than an
    // async round trip through the event loop for a check this frequent.
    return existsSync(this.resolve(key));
  }
}
