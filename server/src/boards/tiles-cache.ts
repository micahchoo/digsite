// The composed-tile cache: small (64 MB), keyed by URL, dropped per board
// when that board's ranks go stale. This is NOT what makes a single viewer's
// pan fast — the ladder's page residency is (ladder.ts) — this cache exists
// for the second viewer requesting a tile someone already composed. See
// .claude/rules/tile-cache-is-for-the-second-viewer.md.
const BUDGET_BYTES = 64 * 1024 * 1024;

type Entry = { buf: Buffer; boardId: string };
const cache = new Map<string, Entry>();
let bytes = 0;

// Roadmap C2: a tile composed from an old order could finish AFTER the
// invalidation for the new one had emptied the cache, and be stored as
// current. A compose now takes the board's generation before it starts;
// every invalidation moves it on; a tile is stored only if it has not
// moved. The check and the store are one synchronous step, so no
// invalidation can land between them.
const generations = new Map<string, number>();
let everyBoard = 0;

/** The token a compose takes before reading any ranks or pixels. */
export function composedGeneration(boardId: string): string {
  return `${everyBoard}.${generations.get(boardId) ?? 0}`;
}

export function getComposedTile(url: string): Buffer | undefined {
  const hit = cache.get(url);
  if (!hit) return undefined;
  cache.delete(url);
  cache.set(url, hit); // touch for LRU
  return hit.buf;
}

/** Stores a composed tile, unless the board was invalidated since `since`
 * (composedGeneration) was taken; returns whether it was stored. */
export function setComposedTile(
  url: string,
  boardId: string,
  buf: Buffer,
  since: string,
): boolean {
  if (composedGeneration(boardId) !== since) return false;
  const existing = cache.get(url);
  if (existing) bytes -= existing.buf.length;
  cache.set(url, { buf, boardId });
  bytes += buf.length;
  while (bytes > BUDGET_BYTES && cache.size > 0) {
    const oldestKey = cache.keys().next().value as string;
    const oldest = cache.get(oldestKey);
    if (oldest) bytes -= oldest.buf.length;
    cache.delete(oldestKey);
  }
  return true;
}

/** Drops every composed tile, for a process that may have missed
 * invalidations (invalidation.ts, on reconnect). */
export function invalidateAllComposedTiles(): void {
  everyBoard++;
  cache.clear();
  bytes = 0;
}

export function invalidateComposedTiles(boardId: string): void {
  generations.set(boardId, (generations.get(boardId) ?? 0) + 1);
  for (const [k, v] of cache) {
    if (v.boardId === boardId) {
      bytes -= v.buf.length;
      cache.delete(k);
    }
  }
}
