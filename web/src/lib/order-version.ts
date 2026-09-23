// Which build of a board's order the map is showing (roadmap item 7, C3;
// server rule tile-pixels-change-the-build.md). Every answer in ranks, and
// every tile, names the build it came from in `X-Order-Version`. The map
// keeps the newest token per (board, sort): tile URLs carry it as `?v=`,
// so the browser may keep them for a year, and when a newer token arrives
// the map refetches everything it holds in ranks.
//
// Tokens are opaque, so "newer" means "not seen before": a slow answer
// from an older build can never move the map back to it.

type Key = `${string} ${string}`;
const current = new Map<Key, string>();
const seen = new Map<Key, Set<string>>();
const listeners = new Set<() => void>();
/** Board and sort pairs whose answers named no build within one wait. */
const gaveUp = new Set<Key>();

const keyOf = (boardId: string, sort: string): Key => `${boardId} ${sort}`;

/** The token the map should use for this board and sort, if any yet. */
export function orderVersionOf(
  boardId: string,
  sort: string,
): string | undefined {
  return current.get(keyOf(boardId, sort));
}

/** Records a token from an answer. True when it is a new build. */
export function noteOrderVersion(
  boardId: string,
  sort: string,
  token: string,
): boolean {
  const key = keyOf(boardId, sort);
  const known = seen.get(key) ?? new Set<string>();
  seen.set(key, known);
  if (known.has(token)) return false;
  known.add(token);
  current.set(key, token);
  for (const listener of listeners) listener();
  return true;
}

export function subscribeOrderVersion(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The board and sort an API request was about, read from its path, its
 * query and its JSON body; null when it names no board or no sort. */
export function boardAndSortOf(
  path: string,
  body: unknown,
): { boardId: string; sort: string } | null {
  const url = new URL(path, 'http://x');
  const board = url.pathname.match(/^\/boards\/([^/]+)\//)?.[1];
  const tileSort = url.pathname.match(
    /^\/boards\/[^/]+\/tiles\/([^/]+)\//,
  )?.[1];
  let sort = url.searchParams.get('sort') ?? tileSort ?? null;
  if (!sort && typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as { sort?: unknown };
      if (typeof parsed.sort === 'string') sort = parsed.sort;
    } catch {
      // not JSON: no sort
    }
  }
  return board && sort
    ? { boardId: decodeURIComponent(board), sort: decodeURIComponent(sort) }
    : null;
}

/** Test-only: forget every token. */
export function resetOrderVersionsForTest(): void {
  current.clear();
  seen.clear();
  gaveUp.clear();
}

/** The token once one is known, or undefined after `ms`: the first tiles
 * of a visit wait briefly for the cheap first answer in ranks, so they can
 * be asked for as cacheable, instead of once plain and once again. */
export function waitForOrderVersion(
  boardId: string,
  sort: string,
  ms: number,
): Promise<string | undefined> {
  const now = orderVersionOf(boardId, sort);
  if (now) return Promise.resolve(now);
  // A server that names no builds (older, or a stub) is waited for once:
  // after that, tiles go out at once, plain.
  const key = keyOf(boardId, sort);
  if (gaveUp.has(key)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const stop = subscribeOrderVersion(() => {
      const token = orderVersionOf(boardId, sort);
      if (!token) return;
      stop();
      clearTimeout(timer);
      resolve(token);
    });
    const timer = setTimeout(() => {
      stop();
      gaveUp.add(key);
      resolve(undefined);
    }, ms);
  });
}
