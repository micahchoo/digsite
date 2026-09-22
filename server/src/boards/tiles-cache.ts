// The composed-tile cache: small (64 MB), keyed by URL, dropped per board
// when that board's ranks go stale. This is NOT what makes a single viewer's
// pan fast — the ladder's page residency is (ladder.ts) — this cache exists
// for the second viewer requesting a tile someone already composed. See
// .claude/rules/tile-cache-is-for-the-second-viewer.md.
const BUDGET_BYTES = 64 * 1024 * 1024;

type Entry = { buf: Buffer; boardId: string };
const cache = new Map<string, Entry>();
let bytes = 0;

export function getComposedTile(url: string): Buffer | undefined {
  const hit = cache.get(url);
  if (!hit) return undefined;
  cache.delete(url);
  cache.set(url, hit); // touch for LRU
  return hit.buf;
}

export function setComposedTile(
  url: string,
  boardId: string,
  buf: Buffer,
): void {
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
}

export function invalidateComposedTiles(boardId: string): void {
  for (const [k, v] of cache) {
    if (v.boardId === boardId) {
      bytes -= v.buf.length;
      cache.delete(k);
    }
  }
}
