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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { env } from '../env.ts';

type SortEntry = { tiles: Map<string, Buffer>; bytes: number };

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

export function coarseTilesDir(boardId: string, sortId: string): string {
  return `${env.DATA_DIR}/boards/${boardId}/tiles/${sortId}`;
}

export function hasResidentSort(boardId: string, sortId: string): boolean {
  return cache.has(entryKey(boardId, sortId));
}

export function getResidentTile(
  boardId: string,
  sortId: string,
  z: number,
  x: number,
  y: number,
): Buffer | undefined {
  const key = entryKey(boardId, sortId);
  const entry = cache.get(key);
  if (!entry) return undefined;
  cache.delete(key);
  cache.set(key, entry); // touch for LRU
  return entry.tiles.get(tileKey(z, x, y));
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
): boolean {
  let bytes = 0;
  for (const buf of tiles.values()) bytes += buf.length;
  if (bytes > budgetBytes()) return false;

  const key = entryKey(boardId, sortId);
  const existing = cache.get(key);
  if (existing) totalBytes -= existing.bytes;
  evictUntilFits(bytes);
  cache.set(key, { tiles, bytes });
  totalBytes += bytes;
  return true;
}

/** Reads a (board, sort)'s z<=-3 tile files off disk and installs them
 * resident in one pass — for a board whose materialised files already
 * exist but this process has never held them (a restart; a different
 * process materialised them). `materialiseSort` calls `setResidentSort`
 * directly with the buffers it just encoded so the tile route's first
 * request after a fresh materialise never re-reads disk at all; this is
 * only for the "files exist, nobody resident" case. */
export async function loadResidentSortFromDisk(
  boardId: string,
  sortId: string,
): Promise<boolean> {
  if (hasResidentSort(boardId, sortId)) return true;
  const dir = coarseTilesDir(boardId, sortId);
  const tiles = new Map<string, Buffer>();
  for (const z of [-3, -4, -5]) {
    const zDir = `${dir}/${z}`;
    if (!existsSync(zDir)) continue;
    for (const file of readdirSync(zDir)) {
      if (!file.endsWith('.png')) continue;
      const [x, y] = file.slice(0, -'.png'.length).split('-');
      tiles.set(
        tileKey(z, Number(x), Number(y)),
        readFileSync(`${zDir}/${file}`),
      );
    }
  }
  if (tiles.size === 0) return false;
  return setResidentSort(boardId, sortId, tiles);
}

/** Drops a board's resident sorts — every one, since staleness
 * (`markBoardRanksStale`) applies to the whole board and a targeted rebuild
 * (`forceRebuildRank`) doesn't know which sorts had files materialised.
 * Mirrors `tiles-cache.ts#invalidateComposedTiles`'s board-wide sweep. */
export function invalidateResidentSort(boardId: string): void {
  const prefix = `${boardId}:`;
  for (const [k, v] of cache) {
    if (k.startsWith(prefix)) {
      totalBytes -= v.bytes;
      cache.delete(k);
    }
  }
}
