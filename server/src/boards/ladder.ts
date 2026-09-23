import {
  LADDER,
  type LadderSize,
  PAGE,
  ladderAddress,
} from '@digsite/shared/board/ladder';
// The ladder (CONTEXT.md "Ladder"): an image's pixels at 8/32/128px, packed
// into 512px pages keyed by slot (never rank — .claude/rules/
// ladder-slot-vs-rank.md). Decoded pages are kept resident in one LRU across
// every open board, budgeted by LADDER_BUDGET_MB — that residency, not the
// composed-tile cache, is what makes a tile fast for the first viewer
// (.claude/rules/tile-cache-is-for-the-second-viewer.md). This cache is for
// the on-demand compose path (tiles.ts) and uploads (paintLadder) — callers
// that revisit the same page. boards/materialise.ts's scatter path reads
// pages directly off disk instead (its own loadPageDirect, not exported
// from here): it visits every page of a size exactly once, so caching there
// buys nothing and would only evict what a live viewer's pan has resident
// while a board materialises in the background.
import {
  type Canvas,
  type Image,
  createCanvas,
  loadImage,
} from '@napi-rs/canvas';
import { env } from '../env.ts';
import { storageFromEnv } from '../storage/index.ts';
import { withLock } from '../storage/lock.ts';
import { Semaphore } from '../util/semaphore.ts';

const PAGE_BYTES = PAGE * PAGE * 4; // decoded RGBA, the naive raw-pixel size
// docs/measurements/phase-5.md "After the leftovers", problem 1: PAGE_BYTES
// is what a 512x512 RGBA buffer costs on paper, not what a resident
// @napi-rs/canvas Canvas actually costs once its pixels are read (which
// drawImage-as-source, this cache's whole purpose, always does). Measured
// in isolation (2,000 PAGE-sized canvases, non-uniform content so no OS
// zero-page sharing can hide it, `canvas.data()` called to force
// materialisation, held alive, RSS before/after): 1,613 KB/canvas against
// PAGE_BYTES's 1,024 KB — a ~1.58x gap this budget's own arithmetic had no
// way to see, on top of (not instead of) the per-request leak fixed below.
// Calibrated to 1.6x (a little conservative) so LADDER_BUDGET_MB bounds
// REAL resident memory, not the nominal pixel count.
const CANVAS_OVERHEAD_FACTOR = 1.6;
const MAX_PAGES = Math.max(
  1,
  Math.floor(
    (env.LADDER_BUDGET_MB * 1024 * 1024) /
      (PAGE_BYTES * CANVAS_OVERHEAD_FACTOR),
  ),
);

const cache = new Map<string, Canvas>(); // key: "boardId/S/page", LRU by insertion order
let evictions = 0; // pages dropped by cacheSet's own budget loop, cumulative for this process

// docs/measurements/phase-5.md "After the leftovers", problem 1 (the leak).
// `residentBytes()` below (`cache.size * PAGE_BYTES`) is only ever honest
// about what's tracked RIGHT NOW — it was never honest about what an
// eviction actually cost. @napi-rs/canvas's native pixel buffer is never
// reclaimed once a Canvas is created, even by a forced GC against an object
// with zero remaining references (measured in isolation, matching
// materialise.ts's own per-page-canvas finding but stronger: `Bun.gc(true)`
// forced every 2,000 iterations made no measurable difference against never
// calling it at all — this is not a GC-timing problem, the buffer is simply
// never freed while the process lives). So every `cache.delete` in the old
// version of this file's eviction loop, followed by the next miss's
// `createCanvas`, permanently grew RSS by one PAGE_BYTES-sized native buffer
// that this file's own accounting had already forgotten about — the
// "accounting vs reality" gap this rule's budget assumed didn't exist. Under
// a viewer thrashing z=0/-1 (S=128's page population is two orders of
// magnitude bigger than any budget holds resident — see this rule's own
// "single-viewer latency" section), that's thousands of evict+reload cycles
// an hour, each one a real, unrecovered PAGE_BYTES leak on top of the
// budget. Fix: never let a page's Canvas become garbage. `cacheSet`'s
// eviction loop hands the outgoing Canvas to `releasePageCanvas` instead of
// dropping it, and `loadPageCanvas` draws into a reused one from
// `acquirePageCanvas` before ever calling `createCanvas` fresh. A page's
// paint (`fillStyle`+`fillRect` covering the whole PAGE, then `drawImage` of
// the stored page PNG at 0,0, itself PAGE x PAGE) already overwrites every
// pixel, so a reused canvas is indistinguishable from a freshly-created one
// to any caller — no separate clear needed.
//
// Lead review round 2 (docs/measurements/phase-5.md "After the leftovers",
// problem 1): a CAPPED free list bounds how many canvases are HELD, not how
// many are ever CREATED — every canvas that falls off a list capped at 32
// is a permanent leak (nothing frees a native buffer once one exists), and
// a cold pan creates far more than 32 at once: one z<=-1 tile touches
// hundreds of distinct S=128/S=32 pages, a browser fires many tiles
// concurrently, so thousands of `loadPageCanvas` calls can be in flight
// together — exactly the 16 GB-in-12 s shape the coordinator reproduced.
// The invariant that actually bounds total canvases ever created is
// "resident budget (MAX_PAGES) + however many loads are allowed in flight
// at once" — `pageLoadSemaphore` bounds the second term, so the free list
// below is UNCAPPED (every evicted canvas goes back to it) and correctness
// follows from concurrent creation never being allowed to outrun it.
const PAGE_LOAD_CONCURRENCY = 16;
const pageLoadSemaphore = new Semaphore(PAGE_LOAD_CONCURRENCY);

const freePageCanvases: Canvas[] = [];

function acquirePageCanvas(): Canvas {
  return freePageCanvases.pop() ?? createCanvas(PAGE, PAGE);
}

function releasePageCanvas(canvas: Canvas): void {
  freePageCanvases.push(canvas);
}

// Lead review round 2, problem 3: "a Canvas is always read synchronously
// right after its await resolves" was true for a single unshared getPage
// call, but the in-flight dedup below means SEVERAL callers can await the
// SAME promise, each resuming in its OWN later microtask — a DIFFERENT
// eviction (for an unrelated key) can run between two of those resumptions
// and, under the fairness picker's "furthest over floor" rule, could in
// principle pick a page one of those still-pending awaiters is about to
// read. `pinCount` makes this safe BY CONSTRUCTION instead of by argument:
// `withPage` increments it the instant it has the canvas in hand (still
// inside its own synchronous continuation) and decrements it after the
// caller's synchronous `draw` returns; `pickEvictionKey` never selects a
// pinned entry. See ladder-fairness.test.ts's adversarial-interleaving
// test.
const pinCount = new Map<string, number>();

function pinKey(key: string): void {
  pinCount.set(key, (pinCount.get(key) ?? 0) + 1);
}

function unpinKey(key: string): void {
  const n = (pinCount.get(key) ?? 0) - 1;
  if (n <= 0) pinCount.delete(key);
  else pinCount.set(key, n);
}

function isPinned(key: string): boolean {
  return (pinCount.get(key) ?? 0) > 0;
}

function cacheKey(boardId: string, s: LadderSize, page: number): string {
  return `${boardId}/${s}/${page}`;
}

// docs/measurements/phase-5.md "After the leftovers", problem 2 (multi-board
// fairness) and .claude/rules/tile-cache-is-for-the-second-viewer.md's own
// "Built" section: with 20 boards panning at once and one process-wide LRU,
// every board's pages get evicted by the NEXT board's request before this
// board's OWN next request can reuse them — the eviction-rate ramp (10k ->
// 93k/minute) and z>=-2's order-of-magnitude latency regression measured
// there. A single global LRU has no notion that a board with a viewer
// RIGHT NOW deserves to keep some pages over a board nobody has looked at
// in a while — every entry is equally evictable by insertion order alone.
//
// The fix: a board counts as "active" while it has been read from within
// `LADDER_ACTIVE_WINDOW_MS` (env.ts, default 5 minutes), and every active
// board gets a FLOOR share of MAX_PAGES — MAX_PAGES / (number of currently
// active boards) — that eviction refuses to cut into as long as ANY other
// board is further over its own floor. This is a soft preference, not a
// reservation: the floor recomputes on every eviction (as boards become
// active/inactive) and, if every resident board is already at or under its
// own floor, whichever is LEAST under still gets picked — the budget itself
// is never allowed to grow past MAX_PAGES to honour a floor. A too-small
// LADDER_BUDGET_MB for the number of concurrently active boards still
// thrashes; the floor changes WHO pays for that thrashing (the board
// hogging the most over its fair share, first) rather than making it
// disappear — this rule's own "Built" section has the numbers a smaller
// load run measured before and after.
//
// `boardPages` is a per-board ordered set (insertion/touch order, same
// trick as `cache` itself) so the eviction loop below never has to scan the
// GLOBAL LRU order looking for an eligible entry — an early version did
// exactly that, capped at a fixed scan depth for cost, and a test caught
// the resulting bug immediately: when one board's own block of resident
// pages is larger than the scan cap and sits at the front of the global
// LRU (exactly the shape two boards produce — one board's pages all older
// than the other's), the capped scan gives up and falls back to evicting
// the OLDEST entry regardless of whose floor that violates, silently
// undoing the whole feature in precisely the case it exists for. Picking
// the board furthest over its floor directly (a scan over the small number
// of BOARDS with anything resident, not over the whole cache) is both
// correct and cheap — see ladder-fairness.test.ts.
const boardLastActive = new Map<string, number>();
const boardPages = new Map<string, Map<string, true>>(); // boardId -> ordered set of its resident keys

function boardOfKey(key: string): string {
  const slash = key.indexOf('/');
  return slash === -1 ? key : key.slice(0, slash);
}

function touchBoardActive(boardId: string): void {
  boardLastActive.set(boardId, Date.now());
}

/** Also prunes stale entries as it scans — lead review round 2, problem 4:
 * `boardLastActive` grew by one entry per board ever viewed, forever.
 * Dropping a stale entry doesn't change any verdict (a missing entry reads
 * as `0`, i.e. "not active", exactly like a stale one) and it comes back
 * the next time that board is actually touched — this is called on every
 * eviction, which is frequent enough under real load to keep the map
 * bounded to roughly the boards active in the last window. */
function activeBoardCount(now: number): number {
  let n = 0;
  for (const [boardId, last] of boardLastActive) {
    if (now - last > env.LADDER_ACTIVE_WINDOW_MS) {
      boardLastActive.delete(boardId);
      continue;
    }
    n++;
  }
  return n;
}

function addToBoard(boardId: string, key: string): void {
  let pages = boardPages.get(boardId);
  if (!pages) {
    pages = new Map();
    boardPages.set(boardId, pages);
  }
  pages.set(key, true);
}

function removeFromBoard(boardId: string, key: string): void {
  const pages = boardPages.get(boardId);
  if (!pages) return;
  pages.delete(key);
  if (pages.size === 0) boardPages.delete(boardId); // bound iteration below to boards actually holding pages
}

/** The oldest page of whichever RESIDENT board is furthest over its floor
 * share (an inactive board counts as having floor 0, so it's always the
 * first to give pages back). Falls back to the global LRU-oldest only if
 * `boardPages` is somehow empty while `cache` isn't (shouldn't happen —
 * every cache entry has a board). */
/** The oldest UNPINNED page of whichever resident board is furthest over
 * its floor — tries boards in that order (not just the single furthest-
 * over one) because that board's entire resident set could be pinned right
 * now. Returns `undefined` only if literally every resident page across
 * every board is pinned, which `cacheSet`'s caller must tolerate (the
 * budget is momentarily exceeded rather than evicting something in use —
 * resolves itself as soon as any pin releases, which is synchronous and
 * brief by construction). */
function pickEvictionKey(): string | undefined {
  const now = Date.now();
  const active = activeBoardCount(now);
  const floor = active > 0 ? MAX_PAGES / active : 0;

  const candidates: { over: number; pages: Map<string, true> }[] = [];
  for (const [boardId, pages] of boardPages) {
    if (pages.size === 0) continue;
    const lastActive = boardLastActive.get(boardId) ?? 0;
    const isActive = now - lastActive <= env.LADDER_ACTIVE_WINDOW_MS;
    const over = isActive ? pages.size - floor : Number.POSITIVE_INFINITY;
    candidates.push({ over, pages });
  }
  candidates.sort((a, b) => b.over - a.over);

  for (const c of candidates) {
    for (const key of c.pages.keys()) {
      if (!isPinned(key)) return key;
    }
  }
  return undefined;
}

function cacheGet(key: string): Canvas | undefined {
  const v = cache.get(key);
  if (v) {
    const boardId = boardOfKey(key);
    cache.delete(key);
    cache.set(key, v);
    removeFromBoard(boardId, key);
    addToBoard(boardId, key);
    touchBoardActive(boardId);
  }
  return v;
}

function cacheSet(key: string, v: Canvas): void {
  // paintLadder repaints an already-resident page in place at upload time
  // (it calls loadPageCanvas directly, not getPage, so it never sees this
  // key's existing entry) and hands the new canvas here — Map#set on an
  // existing key silently drops the old value with no eviction-loop pass
  // over it, which would have been exactly the orphaned-canvas leak this
  // file exists to close. Release it the same way an LRU eviction does.
  const boardId = boardOfKey(key);
  const existing = cache.get(key);
  if (existing) {
    // paintLadder repainting an already-resident page can race a concurrent
    // reader mid-`withPage` draw of the SAME key (upload landing on a page
    // someone's viewport is currently drawing from) — `isPinned` here is
    // the same "never recycle a pinned canvas" guarantee as the eviction
    // loop below, just for the one release site that isn't reached through
    // `pickEvictionKey`. Pinned: don't release it — a rare, one-off,
    // bounded cost (see the leak note above), not a repeating one.
    if (existing !== v && !isPinned(key)) releasePageCanvas(existing);
  } else {
    addToBoard(boardId, key);
  }
  cache.set(key, v);
  touchBoardActive(boardId);
  while (cache.size > MAX_PAGES) {
    const victimKey = pickEvictionKey();
    if (victimKey === undefined) break; // every resident page is pinned right now
    const victimCanvas = cache.get(victimKey);
    cache.delete(victimKey);
    evictions++;
    removeFromBoard(boardOfKey(victimKey), victimKey);
    if (victimCanvas) releasePageCanvas(victimCanvas);
  }
}

/** Estimated REAL bytes the resident ladder-page LRU holds right now —
 * `cache.size * PAGE_BYTES * CANVAS_OVERHEAD_FACTOR`, calibrated against
 * measured native memory per resident canvas (see `CANVAS_OVERHEAD_FACTOR`'s
 * own comment above), not the raw-pixel-only count this used to report. For
 * `GET /metrics` (docs/phases/5-hardening.md section 4's last bullet,
 * metrics.ts's own header comment names this file) and for
 * scripts/load-boards.ts's RSS/residency reporting. */
export function residentBytes(): number {
  return Math.round(cache.size * PAGE_BYTES * CANVAS_OVERHEAD_FACTOR);
}

/** Pages dropped by the LRU's own budget loop since process start (or the
 * last `resetEvictionCountForTest`) — scripts/load-boards.ts's "ladder
 * evictions per minute" is this, sampled a minute apart. */
export function evictionCount(): number {
  return evictions;
}

/** Test-only: a fresh process's worth of the counter, matching
 * metrics.ts#resetMetricsForTest's own reasoning — a test asserting on
 * eviction counts shouldn't depend on what earlier tests in the same run
 * evicted. */
export function resetEvictionCountForTest(): void {
  evictions = 0;
}

/** Boards counted "active" (read within LADDER_ACTIVE_WINDOW_MS) right now
 * — for `GET /metrics` and scripts/load-boards.ts's own reporting, so the
 * fairness floor problem 2 added is as observable as the residency numbers
 * it protects. */
export function activeBoardsForMetrics(): number {
  return activeBoardCount(Date.now());
}

/** Test-only: how many pages of `boardId` are resident right now — the
 * fairness floor's own effect isn't visible from `residentBytes()` (a
 * process-wide total), so a test proving one board keeps its floor share
 * under another board's pressure needs this. */
export function residentPagesForTest(boardId: string): number {
  return boardPages.get(boardId)?.size ?? 0;
}

/** Test-only: MAX_PAGES for this process, so a test can compute an expected
 * floor share without hardcoding PAGE/LADDER_BUDGET_MB's arithmetic. */
export function maxPagesForTest(): number {
  return MAX_PAGES;
}

export function ladderPageKey(
  boardId: string,
  s: LadderSize,
  page: number,
): string {
  return `boards/${boardId}/ladder/${s}/page-${page}.png`;
}

async function loadPageCanvas(
  boardId: string,
  s: LadderSize,
  page: number,
): Promise<Canvas> {
  const key = ladderPageKey(boardId, s, page);
  const canvas = acquirePageCanvas();
  // In @napi-rs/canvas 0.1.100, repeated decoded-Image draws into a reused
  // destination canvas retain native memory; resetting its dimensions
  // before a new PNG keeps RSS flat in the page-churn reproduction.
  // clearRect/fillRect alone did not. Without this, a cold pan that churns
  // past the ladder LRU grows RSS even though every Canvas is recycled. See
  // scripts/repro-ladder-page-churn.ts for the bounded real-cache repro.
  canvas.width = PAGE;
  canvas.height = PAGE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, PAGE, PAGE);
  const bytes = await storageFromEnv().get(key);
  if (bytes) {
    const img = await loadImage(Buffer.from(bytes));
    ctx.drawImage(img, 0, 0);
  }
  return canvas;
}

// Reported by the coordinator: an 11.9 s cold-start-to-16 GB-cap OOM kill
// under a real browser's pan, with a single `compose;dur=3204ms` on the
// last logged tile before the kill — a cold pan across coarse zooms (z=0/
// -1, per this rule's own "single-viewer latency" numbers above) issues
// many near-simultaneous requests whose destination tiles overlap heavily
// in which S=128 pages they need. Without this, N concurrent misses for
// the SAME (board, size, page) each ran their own `loadPageCanvas` —
// independently decoding the same bytes into N separate canvases, only the
// LAST of which `cacheSet` keeps (the other N-1 are released to the free
// list per `cacheSet`'s own existing-key handling, so this was never an
// unbounded per-miss leak the way the un-pooled version was) — but a burst
// of dozens of duplicate decodes competing for CPU at once is exactly the
// shape that produces a multi-second compose and, transiently, several
// times the intended number of live canvases at once during the burst
// itself. A single in-flight promise per key means a burst of misses for
// the same page decodes it once; every other caller in the burst awaits
// that one decode and reads the same (already cache-set) canvas.
const inFlight = new Map<string, Promise<Canvas>>();

/** A decoded ladder page, cached — internal. `withPage` below is the safe
 * public API (pins the result for the duration of a synchronous draw); this
 * is exported only for `ladder-fairness.test.ts`, which probes residency
 * without needing to read pixels from what it gets back. `loadPageCanvas`
 * runs under `pageLoadSemaphore` (bounded concurrency — see its own
 * comment above): a burst of misses for DIFFERENT pages still queues past
 * `PAGE_LOAD_CONCURRENCY`, which is exactly the invariant that keeps total
 * canvases-ever-created bounded. Reading never writes to disk. */
export async function getPage(
  boardId: string,
  s: LadderSize,
  page: number,
): Promise<Canvas> {
  const key = cacheKey(boardId, s, page);
  const hit = cacheGet(key);
  if (hit) return hit;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = pageLoadSemaphore
    .run(() => loadPageCanvas(boardId, s, page))
    .then((canvas) => {
      cacheSet(key, canvas);
      return canvas;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

/** The safe way to read a page's pixels: pins the canvas for exactly the
 * duration of `draw` (synchronous — the moment `draw` needs an `await`, the
 * canvas is no longer provably safe from a concurrent eviction, and the
 * caller should restructure, not hold the pin longer) so it cannot be
 * recycled out from under an in-flight-dedup awaiter that hasn't resumed
 * yet — see this file's `pinCount` comment above and `ladder-fairness.
 * test.ts`'s adversarial-interleaving test. */
export async function withPage<T>(
  boardId: string,
  s: LadderSize,
  page: number,
  draw: (canvas: Canvas) => T,
): Promise<T> {
  const key = cacheKey(boardId, s, page);
  // Pinned BEFORE the await, not after it resolves — several concurrent
  // callers can share one `getPage` in-flight promise (the cold-pan dedup
  // above) and each resumes in its OWN later microtask; pinning only AFTER
  // resolution leaves a real gap between one caller's unpin and the next
  // caller's pin, during which an unrelated eviction (a different board's
  // flood) could recycle this exact canvas. Pinning the KEY up front closes
  // that gap: as long as ANY caller for this key is still in flight —
  // waiting for the load or reading the result — the key can never reach
  // zero pins. Safe to pin before the canvas exists: `pickEvictionKey` only
  // ever considers keys already in `boardPages`, so pinning an
  // as-yet-unresident key is a no-op until `cacheSet` makes it resident.
  pinKey(key);
  try {
    const canvas = await getPage(boardId, s, page);
    return draw(canvas);
  } finally {
    unpinKey(key);
  }
}

/**
 * Paints one uploaded image into every ladder size's page, square,
 * contained and centred on #222. Read page, draw, write page, under the
 * page's lock (storage/lock.ts) so a concurrent upload to the same page
 * cannot lose a write — the only thing preventing that loss once the write
 * is a `put` to S3 rather than an in-place file edit (no append there).
 */
export async function paintLadder(
  boardId: string,
  slot: number,
  image: Image,
  imgWidth: number,
  imgHeight: number,
): Promise<void> {
  for (const s of LADDER) {
    const { page, x, y } = ladderAddress(slot, s);
    const key = cacheKey(boardId, s, page);
    await withLock(key, async () => {
      // Same semaphore as getPage's read path (above) — WORKER_CONCURRENCY
      // (4 by default) already bounds this more tightly in practice, but
      // the invariant this file relies on ("total canvases ever created
      // <= MAX_PAGES + PAGE_LOAD_CONCURRENCY") shouldn't depend on that
      // staying true independently.
      const canvas = await pageLoadSemaphore.run(() =>
        loadPageCanvas(boardId, s, page),
      );
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#222';
      ctx.fillRect(x, y, s, s);
      const scale = Math.min(s / imgWidth, s / imgHeight);
      const dw = imgWidth * scale;
      const dh = imgHeight * scale;
      const dx = x + (s - dw) / 2;
      const dy = y + (s - dh) / 2;
      ctx.drawImage(image, dx, dy, dw, dh);

      const storageKey = ladderPageKey(boardId, s, page);
      await storageFromEnv().put(
        storageKey,
        canvas.encodeSync('png'),
        'image/png',
      );
      cacheSet(key, canvas);
    });
  }
}
