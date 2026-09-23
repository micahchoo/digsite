// A materialised sort's z<=-3 tiles, resident per open board — the "next
// lever" .claude/rules/tile-cache-is-for-the-second-viewer.md named before
// materialisation existed, now that materialisation does. ~124 MB per sort
// at 1,000,000 images (docs/measurements/phase-1-map.md). LRU across
// (board, sort) whole sets, not individual tiles — a sort is loaded and
// evicted as one unit, the same unit `materialiseSort` writes and a stale
// rebuild invalidates.
//
// This is NOT the composed-tile cache (tiles-cache.ts, 64 MB, keyed by URL,
// z-agnostic) and NOT the ladder page cache (ladder.ts, keyed by board/size/
// page). Three caches, three jobs: ladder residency is what makes the FIRST
// viewer's miss fast; the composed-tile cache is for a SECOND viewer hitting
// a tile someone already composed; this one is for z<=-3 once a sort has
// been materialised, so a coarse pan never has to compose or even touch the
// per-tile path again.
import { env } from '../env.ts';
import { storageFromEnv } from '../storage/index.ts';
import { coarseTilesPrefix } from './paths.ts';

/** `version` is the order build the tiles were materialised from. */
type SortEntry = { tiles: Map<string, Buffer>; bytes: number; version: string };
export type ResidentTile = { buf: Buffer; version: string };

// key: "boardId:sortId", LRU by touch order (Map's own iteration order).
const cache = new Map<string, SortEntry>();
let totalBytes = 0;

function budgetBytes(): number {
  return env.COARSE_BUDGET_MB * 1024 * 1024;
}

function entryKey(boardId: string, sortId: string): string {
  return `${boardId}:${sortId}`;
}

function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}-${y}`;
}

export function hasResidentSort(boardId: string, sortId: string): boolean {
  return cache.has(entryKey(boardId, sortId));
}

/** Bytes every resident (board, sort) set holds right now — `totalBytes` is
 * already kept in step with every insert/evict below, so this just exposes
 * it. For `GET /metrics` (docs/phases/5-hardening.md section 4's last
 * bullet, metrics.ts's own header comment names this file) and
 * scripts/load-boards.ts's residency reporting. */
export function residentBytes(): number {
  return totalBytes;
}

export function getResidentTile(
  boardId: string,
  sortId: string,
  z: number,
  x: number,
  y: number,
): ResidentTile | undefined {
  const key = entryKey(boardId, sortId);
  const entry = cache.get(key);
  if (!entry) return undefined;
  cache.delete(key);
  cache.set(key, entry); // touch for LRU
  const buf = entry.tiles.get(tileKey(z, x, y));
  return buf ? { buf, version: entry.version } : undefined;
}

function evictUntilFits(incoming: number): void {
  while (totalBytes + incoming > budgetBytes() && cache.size > 0) {
    const oldestKey = cache.keys().next().value as string;
    const oldest = cache.get(oldestKey);
    if (oldest) totalBytes -= oldest.bytes;
    cache.delete(oldestKey);
  }
}

/** Installs a whole (board, sort)'s tile buffers as one resident unit.
 * Returns false (and caches nothing) when this sort alone is bigger than
 * the whole budget — the caller falls back to per-tile disk reads
 * (`X-Cache: disk`) rather than spin evicting everything for a set that can
 * never fit. */
export function setResidentSort(
  boardId: string,
  sortId: string,
  tiles: Map<string, Buffer>,
  version: string,
): boolean {
  let bytes = 0;
  for (const buf of tiles.values()) bytes += buf.length;
  if (bytes > budgetBytes()) return false;

  const key = entryKey(boardId, sortId);
  const existing = cache.get(key);
  if (existing) totalBytes -= existing.bytes;
  evictUntilFits(bytes);
  cache.set(key, { tiles, bytes, version });
  totalBytes += bytes;
  return true;
}

/** Reads a (board, sort)'s z<=-3 tile files through `Storage.list` and
 * installs them resident in one pass — for a board whose materialised
 * files already exist but this process has never held them (a restart; a
 * different process materialised them). `materialiseSort` calls
 * `setResidentSort` directly with the buffers it just encoded so the tile
 * route's first request after a fresh materialise never re-reads disk (or
 * bucket) at all; this is only for the "files exist, nobody resident" case.
 * Works identically on fs and s3 (docs/phases/5-hardening.md section 5) —
 * before `Storage.list` existed this was an fs-only directory walk and a
 * deliberate no-op under STORAGE=s3; the caller (tiles.ts#materialisedTile)
 * still falls back to a single-key `storage.get` per tile when this returns
 * false (a sort bigger than COARSE_BUDGET_MB), so correctness never
 * depended on this running — only "does a restarted process re-warm a
 * whole sort at once, or one GET per tile until the next materialise" did. */
export async function loadResidentSortFromDisk(
  boardId: string,
  sortId: string,
  version: string,
): Promise<boolean> {
  if (hasResidentSort(boardId, sortId)) return true;
  const storage = storageFromEnv();
  const prefix = coarseTilesPrefix(boardId, sortId);
  const tiles = new Map<string, Buffer>();

  // Fetch keys with bounded concurrency — a materialised sort is 5,216
  // files at 1,000,000 images (docs/measurements/phase-1-map.md), and
  // serial GETs would make this warm-up slower under s3 than just letting
  // every request fall through to its own per-tile disk read.
  const keys: string[] = [];
  for await (const key of storage.list(prefix)) {
    if (key.endsWith('.png')) keys.push(key);
  }
  const CONCURRENCY = 32;
  for (let i = 0; i < keys.length; i += CONCURRENCY) {
    const chunk = keys.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (key) => {
        const rel = key.slice(prefix.length); // "-3/0-0.png"
        const slash = rel.indexOf('/');
        if (slash === -1) return;
        const z = Number(rel.slice(0, slash));
        const file = rel.slice(slash + 1, -'.png'.length);
        const [x, y] = file.split('-');
        const bytes = await storage.get(key);
        if (!bytes) return;
        tiles.set(tileKey(z, Number(x), Number(y)), Buffer.from(bytes));
      }),
    );
  }

  if (tiles.size === 0) return false;
  return setResidentSort(boardId, sortId, tiles, version);
}

/** Drops a board's resident sorts — every one, since staleness
 * (`markBoardRanksStale`) applies to the whole board and a targeted rebuild
 * (`forceRebuildRank`) doesn't know which sorts had files materialised.
 * Mirrors `tiles-cache.ts#invalidateComposedTiles`'s board-wide sweep. */
/** Drops every resident sort, for a process that may have missed
 * invalidations (invalidation.ts, on reconnect). */
export function invalidateAllResidentSorts(): void {
  cache.clear();
  totalBytes = 0;
}

export function invalidateResidentSort(boardId: string): void {
  const prefix = `${boardId}:`;
  for (const [k, v] of cache) {
    if (k.startsWith(prefix)) {
      totalBytes -= v.bytes;
      cache.delete(k);
    }
  }
}
