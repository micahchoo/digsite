// The `fs` adapter: today's DATA_DIR layout, byte-for-byte — a key is the
// path relative to DATA_DIR, so `boards/<id>/originals/<sha256>` (a
// Storage key, see index.ts) reads and writes exactly
// `${DATA_DIR}/boards/<id>/originals/<sha256>` on disk, the same file an
// unmigrated deployment already has. No key ever needs translating.
import { type Dirent, existsSync } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
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
    // Write beside, then rename over: a rename within one directory is
    // atomic, so a reader in any process sees the whole old file or the
    // whole new one. writeFile in place truncates first, so a reader (the
    // API composing a tile while the worker repaints the page) could read a
    // partial file.
    const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temp, body);
      await rename(temp, path);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
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

  /** `deletePrefix` (storage/index.ts) calls this ONCE, after every key
   * under `prefix` is gone, to clean up the now-empty directories those
   * files left behind — Storage only has single-key `delete`, and
   * directories are an fs concept the S3 adapter has none of, so this is
   * an fs-specific capability (`deletePrefix` reaches it via
   * `instanceof FsStorage`, the same pattern `storage/index.ts#presignedGetUrl`
   * uses for S3's own capability) rather than a sixth `Storage` interface
   * method.
   *
   * Deliberately NOT done per-file inside `delete()` — that was this
   * method's first version, and it measured badly: `docs/measurements/
   * phase-5.md`'s load run deleted a 500,000-image board (~38,000 files
   * under its `boards/<id>/` prefix) in ~45 seconds, almost all of it
   * `deletePrefix`'s 38,000 individual `readdir`-then-maybe-`rmdir` walks,
   * one per file. One post-order walk of the prefix's own subtree, after
   * every file is already gone, does the same O(directories) work instead
   * of O(files) — for a 500,000-image board, ~33,000 ladder pages fewer
   * `readdir` calls.
   *
   * Post-order: prune a directory's children first, then remove it if that
   * left it empty — including `prefix` itself, so `boards/<id>/` vanishes
   * entirely, never above `root`. */
  async pruneEmptyTree(prefix: string): Promise<void> {
    const rootResolved = resolve(this.root);
    const base = resolve(this.resolve(prefix));
    if (base === rootResolved || !base.startsWith(rootResolved + sep)) return;

    // Returns true if `dir` is empty (or gone) once its own children have
    // been pruned — the caller then knows whether IT can remove `dir`.
    const prune = async (dir: string): Promise<boolean> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return true;
        throw err;
      }
      let empty = true;
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const childEmpty = await prune(join(dir, entry.name));
          if (childEmpty) {
            try {
              await rmdir(join(dir, entry.name));
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code === 'ENOENT') {
                // Already gone (a concurrent prune got here first) — that
                // still counts as "no longer occupying this parent".
              } else if (code === 'ENOTEMPTY') {
                // Gained a new entry between our readdir and this rmdir
                // (a concurrent write) — genuinely not empty; this
                // parent can't be removed either.
                empty = false;
              } else {
                throw err;
              }
            }
          } else {
            empty = false;
          }
        } else {
          empty = false; // a file — deletePrefix's own job, not this one
        }
      }
      return empty;
    };

    if (await prune(base)) {
      try {
        await rmdir(base);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw err;
      }
    }
  }

  async exists(key: string): Promise<boolean> {
    // existsSync, not a stat-and-catch: this is on the tile/preview read
    // path (tiles.ts, boards/routes.ts) and a sync stat is cheaper than an
    // async round trip through the event loop for a check this frequent.
    return existsSync(this.resolve(key));
  }

  /** `prefix` is a directory-shaped key (every caller in this codebase
   * passes one ending in `/`, or a bare `boards/<id>` meaning "everything
   * under it"). Missing entirely is not an error — an empty iterable,
   * matching `get`'s "absent means null" contract, not a thrown ENOENT. */
  async *list(prefix: string): AsyncIterable<string> {
    const root = this.root;
    const base = this.resolve(prefix);

    async function* walk(dir: string): AsyncGenerator<string> {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          yield* walk(full);
        } else if (entry.isFile()) {
          yield relative(root, full).split(sep).join('/');
        }
      }
    }

    yield* walk(base);
  }
}
