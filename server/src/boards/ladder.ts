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

const PAGE_BYTES = PAGE * PAGE * 4; // decoded RGBA
const MAX_PAGES = Math.max(
  1,
  Math.floor((env.LADDER_BUDGET_MB * 1024 * 1024) / PAGE_BYTES),
);

const cache = new Map<string, Canvas>(); // key: "boardId/S/page", LRU by insertion order

function cacheKey(boardId: string, s: LadderSize, page: number): string {
  return `${boardId}/${s}/${page}`;
}

function cacheGet(key: string): Canvas | undefined {
  const v = cache.get(key);
  if (v) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}

function cacheSet(key: string, v: Canvas): void {
  cache.set(key, v);
  while (cache.size > MAX_PAGES) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
  }
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
  const canvas = createCanvas(PAGE, PAGE);
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

/** A decoded ladder page, cached. Reading never writes to disk. */
export async function getPage(
  boardId: string,
  s: LadderSize,
  page: number,
): Promise<Canvas> {
  const key = cacheKey(boardId, s, page);
  const hit = cacheGet(key);
  if (hit) return hit;
  const canvas = await loadPageCanvas(boardId, s, page);
  cacheSet(key, canvas);
  return canvas;
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
      const canvas = await loadPageCanvas(boardId, s, page);
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
